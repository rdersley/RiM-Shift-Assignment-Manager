// Turns a rota grid (one row per date, one column per person) into a weekly schedule per person.
//
// Expected layout, as used by the support team's monthly rota:
//   row: role codes (optional)     e.g. "T1", "AM TL"
//   row: person names              e.g. "Elvhin Dela Cruz"
//   rows: <weekday> | <date> | "5:45 - 14:45" | "" (off) | ...
// Data rows are found by a weekday name in the first column; the names are on the row above the first one.

const WEEKDAYS = { sunday: 'sun', monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat' };
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const OFF_VALUES = new Set(['', 'off', 'rd', 'rest', 'rest day', 'day off', '-']);
const SHIFT_RE = /^(\d{1,2})[:.](\d{2})\s*(?:-|–|—|to)\s*(\d{1,2})[:.](\d{2})$/i;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function weekdayOf(value) {
  const text = clean(value).toLowerCase();
  return WEEKDAYS[text] || Object.entries(WEEKDAYS).find(([name]) => text.length >= 3 && name.startsWith(text))?.[1] || null;
}

function parseShift(value) {
  const m = SHIFT_RE.exec(clean(value));
  if (!m) return null;
  const [sh, sm, eh, em] = m.slice(1).map(Number);
  if (sh > 23 || eh > 24 || sm > 59 || em > 59) return null;
  return { startMinutes: sh * 60 + sm, endMinutes: (eh % 24) * 60 + em };
}

const hhmm = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// Moves a shift by `offsetHours`. If the start crosses midnight, the shift moves to the neighbouring day.
export function shiftEntry({ day, startMinutes, endMinutes }, offsetHours = 0) {
  const offset = Math.round(Number(offsetHours) * 60);
  const rawStart = startMinutes + offset;
  const dayShift = Math.floor(rawStart / 1440);
  const start = ((rawStart % 1440) + 1440) % 1440;
  const end = (((endMinutes + offset) % 1440) + 1440) % 1440;
  const dayIndex = (DAY_KEYS.indexOf(day) + dayShift + 7) % 7;
  return { day: DAY_KEYS[dayIndex], start: hhmm(start), end: hhmm(end) };
}

const sameShift = (a, b) => (a?.startMinutes === b?.startMinutes && a?.endMinutes === b?.endMinutes);

export function parseRota(grid = [], { offsetHours = 0 } = {}) {
  const rows = grid.map(row => (row || []).map(clean));
  const firstData = rows.findIndex(row => weekdayOf(row[0]));
  if (firstData < 1) throw new Error('Could not find the rota rows. The first column should list weekdays (Monday, Tuesday, …) with the names on the row above.');
  const nameRow = rows[firstData - 1];
  const roleRow = firstData >= 2 ? rows[firstData - 2] : [];
  const dataRows = rows.slice(firstData).filter(row => weekdayOf(row[0]));
  const people = [];
  const skipped = [];
  for (let col = 1; col < nameRow.length; col += 1) {
    const name = nameRow[col];
    if (!name) continue;
    // A column with no shift times at all (e.g. a date column, or someone off all month) isn't imported.
    if (!dataRows.some(row => parseShift(row[col]))) { skipped.push(name); continue; }
    const warnings = [];
    const latest = {};
    const history = {};
    for (const row of dataRows) {
      const day = weekdayOf(row[0]);
      const cell = row[col] || '';
      const shift = parseShift(cell);
      if (!shift && !OFF_VALUES.has(cell.toLowerCase())) warnings.push(`"${cell}" on a ${row[0]} isn't a shift time; treated as a day off.`);
      // Later rows overwrite earlier ones, so the most recent week defines the pattern.
      latest[day] = shift;
      (history[day] ||= []).push(shift);
    }
    const changed = Object.values(history).some(list => list.some(s => !sameShift(s, list[list.length - 1])));
    if (changed) warnings.push('Pattern changes during the rota; the most recent week is used.');
    const schedule = DAY_KEYS.filter(day => latest[day]).map(day => shiftEntry({ day, ...latest[day] }, offsetHours));
    if (!schedule.length) warnings.push('No working days found.');
    people.push({ column: col, role: roleRow[col] || '', name, schedule, warnings });
  }
  if (!people.length) throw new Error('No names found on the row above the first weekday row.');
  return { people, skipped, rowCount: dataRows.length };
}
