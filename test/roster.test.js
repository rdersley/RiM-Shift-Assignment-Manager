import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { addDays, buildRoster, zonedMidnight } from '../src/domain/roster.js';
import { normaliseGroup } from '../src/domain/shiftGroups.js';

const publicResolver = await readFile(new URL('../src/schedule.js', import.meta.url), 'utf8');
const rosterService = await readFile(new URL('../src/lib/rosterService.js', import.meta.url), 'utf8');
const backend = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

// Monday 5 – Sunday 11 October 2026 (Irish summer time, UTC+1).
const WEEK = '2026-10-05';

function team({ schedules, overrides = [], name = 'Support Team', id = 'g1', timezone = 'Europe/Dublin' }) {
  const ids = Object.keys(schedules);
  const group = normaliseGroup({ id, name, timezone, memberAccountIds: ids, recurringSchedule: [], memberSchedules: schedules });
  group.memberProfiles = ids.map(accountId => ({ accountId, displayName: accountId.toUpperCase(), role: `R-${accountId}` }));
  group.overrides = overrides;
  return group;
}
const days = (list, start, end) => list.map(day => ({ day, start, end }));
const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'];

test('zonedMidnight handles both sides of the Irish clock change', () => {
  assert.equal(zonedMidnight('2026-10-05', 'Europe/Dublin').toISOString(), '2026-10-04T23:00:00.000Z');
  assert.equal(zonedMidnight('2026-11-02', 'Europe/Dublin').toISOString(), '2026-11-02T00:00:00.000Z');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
});

test('rota grid shows each person\'s shift on the day it starts, with role and weekly hours', () => {
  const r = buildRoster({ groups: [team({ schedules: { a: days(weekdays, '07:00', '16:00') } })], startDate: WEEK, days: 7 });
  const a = r.people[0];
  assert.equal(a.role, 'R-a');
  assert.equal(a.hours, 45);
  assert.deepEqual(r.dates.map(d => a.cells[d.date].shifts.map(s => `${s.start}-${s.end}`).join()), ['07:00-16:00', '07:00-16:00', '07:00-16:00', '07:00-16:00', '07:00-16:00', '', '']);
});

test('overnight shifts are marked +1 and a shift running at the start shows as continued', () => {
  const r = buildRoster({ groups: [team({ schedules: { n: days(['sun', 'mon'], '22:45', '07:45') } })], startDate: WEEK, days: 2 });
  const cells = r.people[0].cells;
  assert.deepEqual(cells['2026-10-05'].shifts.map(s => [s.start, s.end, s.continued, s.overnight]), [['22:45', '07:45', true, false], ['22:45', '07:45', false, true]]);
});

test('cover and absence entries appear in the grid', () => {
  const r = buildRoster({
    groups: [team({
      schedules: { a: days(weekdays, '09:00', '17:00') },
      overrides: [
        { id: 'x', accountId: 'a', type: 'exclude', startAt: '2026-10-06T00:00:00Z', endAt: '2026-10-06T23:00:00Z' },
        { id: 'c', accountId: 'a', type: 'include', startAt: '2026-10-10T09:00:00Z', endAt: '2026-10-10T12:00:00Z' }
      ]
    })],
    startDate: WEEK, days: 7
  });
  const cells = r.people[0].cells;
  assert.equal(cells['2026-10-06'].shifts.length, 0);
  assert.deepEqual(cells['2026-10-06'].absent, [{ start: '09:00', end: '17:00' }]);
  assert.deepEqual(cells['2026-10-10'].shifts.map(s => [s.kind, s.start, s.end]), [['cover', '10:00', '13:00']]);
});

test('coverage finds the hours nobody is on shift', () => {
  const r = buildRoster({ groups: [team({ schedules: { a: days(['mon'], '08:00', '16:00') } })], startDate: WEEK, days: 1, minCoverage: 1 });
  assert.deepEqual(r.coverage.gaps.map(g => g.label), ['Mon 5 Oct 00:00–08:00', 'Mon 5 Oct 16:00 – Tue 6 Oct 00:00']);
  assert.equal(r.coverage.stats.uncoveredMinutes, 16 * 60);
  assert.equal(r.coverage.stats.metMinimumPercent, 33.3);
});

test('coverage flags periods below the minimum and reports peak and lowest', () => {
  const r = buildRoster({
    groups: [team({ schedules: { a: days(['mon'], '00:00', '23:59'), b: days(['mon'], '09:00', '17:00'), c: days(['mon'], '12:00', '14:00') } })],
    startDate: WEEK, days: 1, minCoverage: 2
  });
  assert.equal(r.coverage.stats.peak, 3);
  assert.equal(r.coverage.stats.peakAt, 'Mon 5 Oct 12:00');
  assert.deepEqual(r.coverage.low.map(g => g.label), ['Mon 5 Oct 00:00–09:00', 'Mon 5 Oct 17:00 – Tue 6 Oct 00:00']);
  assert.equal(r.coverage.heat[0].hours[12].min, 3);
  assert.equal(r.coverage.heat[0].hours[8].min, 1);
});

test('someone in two groups is counted once for coverage', () => {
  const g1 = team({ id: 'g1', name: 'A', schedules: { a: days(['mon'], '09:00', '17:00') } });
  const g2 = team({ id: 'g2', name: 'B', schedules: { a: days(['mon'], '09:00', '17:00') } });
  const r = buildRoster({ groups: [g1, g2], startDate: WEEK, days: 1 });
  assert.equal(r.people.length, 2);
  assert.equal(r.coverage.stats.peak, 1);
});

test('times can be shown in Manila time', () => {
  const r = buildRoster({ groups: [team({ schedules: { a: days(['mon'], '07:00', '16:00') } })], startDate: WEEK, days: 1, displayTimeZone: 'Asia/Manila' });
  // Monday 07:00 Irish = Monday 14:00 Manila.
  assert.deepEqual(r.people[0].cells[WEEK].shifts.map(s => `${s.start}-${s.end}`), ['14:00-23:00']);
});

test('disabled groups are left out', () => {
  const g = team({ schedules: { a: days(['mon'], '09:00', '17:00') } });
  g.enabled = false;
  assert.equal(buildRoster({ groups: [g], startDate: WEEK, days: 1 }).people.length, 0);
});

test('people are ordered by when they usually start', () => {
  const r = buildRoster({ groups: [team({ schedules: { late: days(['mon'], '15:00', '23:00'), early: days(['mon'], '06:00', '14:00') } })], startDate: WEEK, days: 1 });
  assert.deepEqual(r.people.map(p => p.accountId), ['early', 'late']);
});

test('a four-week analysis of a 22-person rota stays fast', () => {
  const schedules = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`p${i}`, days(weekdays, `${String(i % 24).padStart(2, '0')}:00`, `${String((i + 9) % 24).padStart(2, '0')}:00`)]));
  const t = Date.now();
  buildRoster({ groups: [team({ schedules })], startDate: WEEK, days: 28 });
  assert.ok(Date.now() - t < 5000, 'roster took too long');
});

test('the public schedule resolver only reads', () => {
  assert.ok(!/kvs\.(set|delete)/.test(publicResolver));
  assert.ok(!/kvs\.(set|delete)/.test(rosterService));
});

test('minimum coverage setting is admin-only', () => {
  const start = backend.indexOf("resolver.define('setMinCoverage'");
  assert.ok(start > 0);
  assert.ok(backend.slice(start, start + 120).includes('await assertAdmin()'));
});

test('people are put into early, day, late and night bands by their usual start', async () => {
  const { shiftBand } = await import('../src/domain/roster.js');
  assert.deepEqual(['06:45', '09:15', '14:45', '22:45', '02:00'].map(t => shiftBand(Number(t.slice(0, 2)) * 60 + Number(t.slice(3)))), ['early', 'day', 'late', 'night', 'night']);
  const r = buildRoster({ groups: [team({ schedules: { a: days(weekdays, '22:45', '07:45'), b: days(['mon', 'tue'], '06:45', '15:45').concat(days(['wed'], '09:00', '17:00')) } })], startDate: WEEK, days: 7 });
  const byId = Object.fromEntries(r.people.map(p => [p.accountId, p]));
  assert.equal(byId.a.band, 'night');
  assert.equal(byId.a.usualShift, '22:45–07:45');
  assert.equal(byId.b.usualShift, '06:45–15:45');
  assert.equal(byId.b.cells['2026-10-07'].shifts[0].band, 'day');
});

test('the workload tab is admin-only in the UI', async () => {
  const admin = await readFile(new URL('../src/frontend/admin.jsx', import.meta.url), 'utf8');
  const page = await readFile(new URL('../src/frontend/schedule.jsx', import.meta.url), 'utf8');
  assert.ok(admin.includes('<WorkloadAnalysis'));
  assert.ok(!page.includes('WorkloadAnalysis'));
});
