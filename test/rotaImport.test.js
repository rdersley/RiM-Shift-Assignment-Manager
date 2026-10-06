import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { strToU8, zipSync } from 'fflate';
import { parseRota, shiftEntry } from '../src/domain/rota.js';
import { matchUser, nameScore } from '../src/domain/userMatch.js';
import { normaliseGroup, normaliseMemberSchedules } from '../src/domain/shiftGroups.js';
import { getOnShiftMembers, isMemberOnShift } from '../src/domain/shifts.js';
import { decodeBase64File, readDelimitedText, readFirstSheet } from '../src/lib/xlsx.js';

const backend = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

// Same layout as the team's monthly rota: role row, name row, then weekday | date | shifts.
const WEEKDAYS = ['Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday', 'Tuesday'];
function rotaGrid({ weeks = 2, cells }) {
  const rows = [['Solution', ' ', 'T TL \r\n', 'T1', 'T2 new', 'AM1'], ['', '', 'Alex One', 'Bea Two', 'Cal Three', 'Dee Four']];
  for (let i = 0; i < weeks * 7; i += 1) rows.push([WEEKDAYS[i % 7], `${i + 1}-Jul`, ...cells(i, WEEKDAYS[i % 7])]);
  return rows;
}
const weekend = day => day === 'Saturday' || day === 'Sunday';
const grid = rotaGrid({
  cells: (i, day) => [
    weekend(day) ? '' : '14:00 - 23:00',
    weekend(day) ? '' : '5:45 - 14:45',
    i < 7 ? (weekend(day) ? '' : '12:00 - 21:00') : (day === 'Monday' || day === 'Tuesday' ? '' : '13:45 - 22:45'),
    day === 'Friday' && i < 7 ? 'AL' : (weekend(day) ? '' : '17:00 - 2:00')
  ]
});

// --- Time conversion ---------------------------------------------------------------------------

test('-7 hours moves an early Manila start to the previous evening in Ireland', () => {
  assert.deepEqual(shiftEntry({ day: 'wed', startMinutes: 5 * 60 + 45, endMinutes: 14 * 60 + 45 }, -7), { day: 'tue', start: '22:45', end: '07:45' });
});

test('-7 hours turns a Manila overnight shift into an Irish day shift', () => {
  assert.deepEqual(shiftEntry({ day: 'wed', startMinutes: 21 * 60 + 45, endMinutes: 6 * 60 + 45 }, -7), { day: 'wed', start: '14:45', end: '23:45' });
  assert.deepEqual(shiftEntry({ day: 'wed', startMinutes: 17 * 60, endMinutes: 2 * 60 }, -7), { day: 'wed', start: '10:00', end: '19:00' });
});

test('Monday early start wraps back to Sunday', () => {
  assert.equal(shiftEntry({ day: 'mon', startMinutes: 5 * 60, endMinutes: 13 * 60 }, -7).day, 'sun');
});

test('a positive adjustment can move a late start to the next day', () => {
  assert.deepEqual(shiftEntry({ day: 'sat', startMinutes: 22 * 60, endMinutes: 6 * 60 }, 3), { day: 'sun', start: '01:00', end: '09:00' });
});

// --- Rota parsing ------------------------------------------------------------------------------

test('reads roles, names and a weekly pattern per person', () => {
  const { people, rowCount } = parseRota(grid, { offsetHours: -7 });
  assert.equal(rowCount, 14);
  assert.deepEqual(people.map(p => [p.role, p.name]), [['T TL', 'Alex One'], ['T1', 'Bea Two'], ['T2 new', 'Cal Three'], ['AM1', 'Dee Four']]);
  assert.deepEqual(people[0].schedule.map(s => `${s.day} ${s.start}-${s.end}`), ['mon 07:00-16:00', 'tue 07:00-16:00', 'wed 07:00-16:00', 'thu 07:00-16:00', 'fri 07:00-16:00']);
  assert.deepEqual(people[1].schedule.map(s => s.day).sort(), ['mon', 'sun', 'thu', 'tue', 'wed']);
});

test('a pattern that changes mid-month uses the latest week and says so', () => {
  const cal = parseRota(grid, { offsetHours: 0 }).people[2];
  assert.deepEqual(cal.schedule.map(s => `${s.day} ${s.start}`).sort(), ['fri 13:45', 'sat 13:45', 'sun 13:45', 'thu 13:45', 'wed 13:45']);
  assert.ok(cal.warnings.some(w => /most recent week/.test(w)));
});

test('a non-time value in an early week warns but the latest week still counts', () => {
  const dee = parseRota(grid, { offsetHours: 0 }).people[3];
  assert.ok(dee.warnings.some(w => w.includes('"AL"')));
  assert.ok(dee.schedule.some(s => s.day === 'fri'));
});

test('columns with no shift times are skipped, not imported as people', () => {
  const g = grid.map((row, i) => [...row, i === 1 ? 'Vacancy' : '']);
  const result = parseRota(g);
  assert.deepEqual(result.skipped, ['Vacancy']);
  assert.equal(result.people.length, 4);
});

test('a grid without weekday rows is rejected with a helpful message', () => {
  assert.throws(() => parseRota([['Name', 'Shift'], ['A', '09:00 - 17:00']]), /first column should list weekdays/);
});

// --- Spreadsheet and paste readers -------------------------------------------------------------

function xlsxBytes(sheetXml, sharedXml) {
  return zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml),
    'xl/sharedStrings.xml': strToU8(sharedXml)
  });
}

test('reads shared, rich-text, inline and numeric cells from an .xlsx', () => {
  const bytes = xlsxBytes(
    '<worksheet><cols><col min="1" max="1"/></cols><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>Monday</t></is></c><c r="B2"><v>46204</v></c><c r="C2" s="1"/></row></sheetData></worksheet>',
    '<sst><si><t xml:space="preserve"> Irene &amp; Co </t></si><si><r><t>5:45</t></r><r><t xml:space="preserve"> - 14:45</t></r></si></sst>'
  );
  assert.deepEqual(readFirstSheet(bytes), [[' Irene & Co ', '', '5:45 - 14:45'], ['Monday', '46204', '']]);
});

test('a file that is not a spreadsheet gives a clear error', () => {
  assert.throws(() => readFirstSheet(new Uint8Array([1, 2, 3])), /not a valid \.xlsx/);
});

test('pasted Excel cells (tab-separated) and CSV are both read', () => {
  assert.deepEqual(readDelimitedText('Monday\t1-Jul\t5:45 - 14:45\r\nTuesday\t2-Jul\t'), [['Monday', '1-Jul', '5:45 - 14:45'], ['Tuesday', '2-Jul', '']]);
  assert.deepEqual(readDelimitedText('"Dela Cruz, E",T1\n'), [['Dela Cruz, E', 'T1'], ['']]);
});

test('base64 file data is decoded with or without a data: prefix', () => {
  const raw = Buffer.from('hello').toString('base64');
  assert.equal(Buffer.from(decodeBase64File(raw)).toString(), 'hello');
  assert.equal(Buffer.from(decodeBase64File(`data:application/octet-stream;base64,${raw}`)).toString(), 'hello');
});

// --- Matching names to Jira users --------------------------------------------------------------

test('exact name match ignores case, spacing and hyphens', () => {
  assert.equal(nameScore(' Pat Go-Aco', 'pat go aco'), 1);
  assert.equal(matchUser('Pat Go-Aco', [{ accountId: '1', displayName: 'Pat Go Aco' }, { accountId: '2', displayName: 'Pat Smith' }]).match.accountId, '1');
});

test('two people with the same name are not auto-matched', () => {
  const { match, candidates } = matchUser('Sam Lee', [{ accountId: '1', displayName: 'Sam Lee' }, { accountId: '2', displayName: 'Sam Lee' }]);
  assert.equal(match, null);
  assert.equal(candidates.length, 2);
});

test('a longer Jira name containing every rota word is a strong match', () => {
  assert.equal(matchUser('Elle Cruz', [{ accountId: '1', displayName: 'Elle Dela Cruz' }]).match?.accountId, '1');
});

test('partial matches are offered but not selected', () => {
  const { match, candidates } = matchUser('Elle Dela Cruz', [{ accountId: '1', displayName: 'Elle Cruz' }]);
  assert.equal(match, null);
  assert.equal(candidates[0].accountId, '1');
});

test('apps and portal customers are never offered', () => {
  const { candidates } = matchUser('Pat', [{ accountId: '1', displayName: 'Pat', accountType: 'app' }, { accountId: '2', displayName: 'Pat', accountType: 'customer' }]);
  assert.equal(candidates.length, 0);
});

// --- Per-person schedules ----------------------------------------------------------------------

const personal = {
  a: [{ day: 'thu', start: '07:00', end: '16:00' }],
  b: [{ day: 'wed', start: '22:45', end: '07:45' }]
};

function teamGroup(overrides = {}) {
  return normaliseGroup({ id: 'g', name: 'Support Team', timezone: 'Europe/Dublin', memberAccountIds: ['a', 'b'], recurringSchedule: [], memberSchedules: personal, ...overrides });
}

test('a group can rely entirely on personal hours', () => {
  const g = teamGroup();
  assert.deepEqual(g.recurringSchedule, []);
  assert.deepEqual(Object.keys(g.memberSchedules), ['a', 'b']);
});

test('each member is on shift by their own hours', () => {
  const g = teamGroup();
  // 2026-10-01 is a Thursday; Dublin is UTC+1 then.
  assert.deepEqual(getOnShiftMembers({ shiftGroup: g, at: new Date('2026-10-01T09:00:00Z') }), ['a']);
  // Wednesday 22:45 overnight shift is still running at Thursday 06:00 Dublin.
  assert.deepEqual(getOnShiftMembers({ shiftGroup: g, at: new Date('2026-10-01T05:00:00Z') }), ['b']);
});

test('members without personal hours fall back to the group hours', () => {
  const g = normaliseGroup({ id: 'g', name: 'Mixed', timezone: 'UTC', memberAccountIds: ['a', 'c'], schedule: { days: ['thu'], start: '12:00', end: '13:00' }, memberSchedules: { a: personal.a } });
  assert.equal(isMemberOnShift({ shiftGroup: g, accountId: 'c', at: new Date('2026-10-01T12:30:00Z') }), true);
  assert.equal(isMemberOnShift({ shiftGroup: g, accountId: 'a', at: new Date('2026-10-01T12:30:00Z') }), true);
  assert.equal(isMemberOnShift({ shiftGroup: g, accountId: 'a', at: new Date('2026-10-01T17:30:00Z') }), false);
});

test('a group with no group hours needs personal hours for every member', () => {
  assert.throws(() => teamGroup({ memberAccountIds: ['a', 'b', 'c'] }), /members without their own hours/);
});

test('personal hours for people not in the group are dropped', () => {
  assert.deepEqual(Object.keys(normaliseMemberSchedules({ a: personal.a, z: personal.a }, ['a'])), ['a']);
});

test('rota preview and import are admin-only', () => {
  for (const name of ['previewRota', 'importRota']) {
    const start = backend.indexOf(`resolver.define('${name}'`);
    assert.ok(start > 0, `missing ${name}`);
    assert.ok(backend.slice(start, start + 120).includes('await assertAdmin()'), `${name} is not admin-only`);
  }
});

test('editing a group without sending personal hours keeps the stored ones', () => {
  assert.match(backend, /raw\.memberSchedules === undefined && existing\?\.memberSchedules/);
});
