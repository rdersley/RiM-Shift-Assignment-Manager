import { isScheduledAt, localParts, overrideStateAt } from './shifts.js';

// Builds the rota grid (who works when, per day) and the coverage analysis for a date range,
// with every time expressed in one display timezone (Irish time for the support team).
//
// The roster is sampled every `stepMinutes`, so it automatically reflects personal hours, overnight
// shifts, cover/absence entries and clock changes, exactly as the assignment engine sees them.

const DAY_MS = 86_400_000;
const PAD_BEFORE_MS = 12 * 3_600_000; // to see shifts that started the evening before the range
const PAD_AFTER_MS = 18 * 3_600_000; // to see when the last shifts of the range finish

const displayFormatters = new Map();
function displayFormatter(timeZone) {
  if (!displayFormatters.has(timeZone)) {
    displayFormatters.set(timeZone, new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }));
  }
  return displayFormatters.get(timeZone);
}

function wallClock(date, timeZone) {
  const p = Object.fromEntries(displayFormatter(timeZone).formatToParts(date).map(x => [x.type, x.value]));
  return { dateKey: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second), y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

// UTC instant of 00:00 on `dateKey` (YYYY-MM-DD) in `timeZone`.
export function zonedMidnight(dateKey, timeZone) {
  const [y, m, d] = dateKey.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i += 1) {
    const wc = wallClock(new Date(guess), timeZone);
    const asUtc = Date.UTC(wc.y, wc.m - 1, wc.d, wc.hour, wc.minute, wc.second);
    const diff = asUtc - Date.UTC(y, m - 1, d);
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

export function addDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function todayKey(timeZone, now = new Date()) {
  return wallClock(now, timeZone).dateKey;
}

// Shift bands by start time, for grouping and colour in the rota.
export const SHIFT_BANDS = [
  { key: 'early', label: 'Early', from: 4 * 60, to: 8 * 60 },
  { key: 'day', label: 'Day', from: 8 * 60, to: 12 * 60 },
  { key: 'late', label: 'Late', from: 12 * 60, to: 20 * 60 },
  { key: 'night', label: 'Night', from: 20 * 60, to: 28 * 60 }
];
export function shiftBand(startMinute) {
  if (startMinute == null || startMinute >= 9999) return 'off';
  const m = startMinute < 4 * 60 ? startMinute + 24 * 60 : startMinute;
  return SHIFT_BANDS.find(b => m >= b.from && m < b.to)?.key || 'night';
}

const hhmm = wc => `${String(wc.hour).padStart(2, '0')}:${String(wc.minute).padStart(2, '0')}`;

function dayLabel(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function rangeLabel(from, to, timeZone) {
  const a = wallClock(from, timeZone);
  const b = wallClock(to, timeZone);
  return a.dateKey === b.dateKey ? `${dayLabel(a.dateKey)} ${hhmm(a)}–${hhmm(b)}` : `${dayLabel(a.dateKey)} ${hhmm(a)} – ${dayLabel(b.dateKey)} ${hhmm(b)}`;
}

// Contiguous runs of steps where `test(count)` is true, inside [start, end).
function runsOf(counts, times, stepMs, test) {
  const out = [];
  let from = null;
  counts.forEach((count, i) => {
    if (test(count) && from == null) from = times[i];
    if (!test(count) && from != null) { out.push({ from, to: times[i] }); from = null; }
  });
  if (from != null) out.push({ from, to: new Date(times[times.length - 1].getTime() + stepMs) });
  return out;
}

export function buildRoster({ groups = [], startDate, days = 7, displayTimeZone = 'Europe/Dublin', minCoverage = 2, stepMinutes = 5, now = new Date(), includeSeries = false }) {
  const stepMs = stepMinutes * 60_000;
  const start = zonedMidnight(startDate, displayTimeZone);
  const end = zonedMidnight(addDays(startDate, days), displayTimeZone);
  const dateKeys = Array.from({ length: days }, (_, i) => addDays(startDate, i));
  const active = groups.filter(g => g?.enabled !== false);

  // One row per person per group.
  const rows = active.flatMap(group => {
    const profiles = Object.fromEntries((group.memberProfiles || []).map(p => [p.accountId, p]));
    return (group.memberAccountIds || []).map(accountId => ({
      key: `${group.id}:${accountId}`, accountId, group,
      displayName: profiles[accountId]?.displayName || accountId,
      role: profiles[accountId]?.role || '',
      run: null, absence: null, runs: [], absences: []
    }));
  });

  const counts = [];
  const times = [];
  const firstStep = Math.floor((start.getTime() - PAD_BEFORE_MS) / stepMs) * stepMs;
  const lastStep = end.getTime() + PAD_AFTER_MS;
  for (let t = firstStep; t <= lastStep; t += stepMs) {
    const at = new Date(t);
    const partsByZone = new Map();
    const onShift = new Set();
    for (const row of rows) {
      const zone = row.group.timezone || 'UTC';
      if (!partsByZone.has(zone)) partsByZone.set(zone, localParts(at, zone));
      const scheduled = isScheduledAt(row.group, row.accountId, partsByZone.get(zone));
      const override = overrideStateAt(row.group.overrides || [], row.accountId, at);
      const working = override === 'exclude' ? false : override === 'include' ? true : scheduled;
      const absent = scheduled && override === 'exclude';
      if (working) {
        onShift.add(row.accountId);
        if (!row.run) row.run = { from: at, scheduled: false };
        if (scheduled) row.run.scheduled = true;
      } else if (row.run) { row.runs.push({ ...row.run, to: at }); row.run = null; }
      if (absent && !row.absence) row.absence = { from: at };
      if (!absent && row.absence) { row.absences.push({ ...row.absence, to: at }); row.absence = null; }
    }
    if (t >= start.getTime() && t < end.getTime()) { counts.push(onShift.size); times.push(at); }
  }
  const tail = new Date(lastStep + stepMs);
  for (const row of rows) {
    if (row.run) row.runs.push({ ...row.run, to: tail, open: true });
    if (row.absence) row.absences.push({ ...row.absence, to: tail });
  }

  // --- Rota grid -------------------------------------------------------------------------------
  const startKey = dateKeys[0];
  const people = rows.map(row => {
    const cells = Object.fromEntries(dateKeys.map(k => [k, { shifts: [], absent: [] }]));
    let minutesWorked = 0;
    for (const run of row.runs) {
      const overlap = Math.min(run.to, end) - Math.max(run.from, start);
      if (overlap > 0) minutesWorked += overlap / 60_000;
      const from = wallClock(run.from, displayTimeZone);
      const to = wallClock(run.to, displayTimeZone);
      // Shifts belong to the day they start on; a shift already running at the start goes on day one.
      const startedBefore = run.from < start && run.to > start;
      const key = startedBefore ? startKey : from.dateKey;
      if (!cells[key]) continue;
      cells[key].shifts.push({ start: hhmm(from), end: run.open ? '…' : hhmm(to), kind: run.scheduled ? 'shift' : 'cover', band: shiftBand(from.hour * 60 + from.minute), continued: startedBefore, overnight: !run.open && !startedBefore && to.dateKey !== from.dateKey });
    }
    for (const gap of row.absences) {
      const from = wallClock(gap.from, displayTimeZone);
      const key = gap.from < start && gap.to > start ? startKey : from.dateKey;
      if (cells[key]) cells[key].absent.push({ start: hhmm(from), end: hhmm(wallClock(gap.to, displayTimeZone)) });
    }
    // The person's usual shift in this range: the most common start and end time.
    const starts = new Map();
    for (const cell of Object.values(cells)) for (const shift of cell.shifts) if (!shift.continued && shift.kind === 'shift') {
      const id = `${shift.start}–${shift.end}`;
      starts.set(id, (starts.get(id) || 0) + 1);
    }
    const usual = [...starts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
    const sortMinute = usual ? Number(usual.slice(0, 2)) * 60 + Number(usual.slice(3, 5)) : 9999;
    return { key: row.key, accountId: row.accountId, displayName: row.displayName, role: row.role, groupId: row.group.id, groupName: row.group.name, hours: Math.round(minutesWorked / 6) / 10, usualShift: usual, band: shiftBand(sortMinute), sortMinute, cells };
  }).sort((a, b) => a.groupName.localeCompare(b.groupName) || a.sortMinute - b.sortMinute || a.displayName.localeCompare(b.displayName));

  // --- Coverage --------------------------------------------------------------------------------
  const heat = dateKeys.map(dateKey => ({ date: dateKey, label: dayLabel(dateKey), hours: Array.from({ length: 24 }, () => null) }));
  const heatIndex = Object.fromEntries(dateKeys.map((k, i) => [k, i]));
  const hourTotals = Array.from({ length: 24 }, () => ({ sum: 0, n: 0, min: Infinity }));
  times.forEach((at, i) => {
    const wc = wallClock(at, displayTimeZone);
    const cell = heat[heatIndex[wc.dateKey]]?.hours;
    if (cell) {
      const prev = cell[wc.hour];
      cell[wc.hour] = prev ? { min: Math.min(prev.min, counts[i]), max: Math.max(prev.max, counts[i]) } : { min: counts[i], max: counts[i] };
    }
    const h = hourTotals[wc.hour];
    h.sum += counts[i]; h.n += 1; h.min = Math.min(h.min, counts[i]);
  });

  const describe = list => list.map(r => ({ from: r.from.toISOString(), to: r.to.toISOString(), minutes: Math.round((r.to - r.from) / 60_000), label: rangeLabel(r.from, r.to, displayTimeZone) }));
  const gaps = describe(runsOf(counts, times, stepMs, c => c === 0));
  const low = describe(runsOf(counts, times, stepMs, c => c > 0 && c < minCoverage));
  const peak = counts.reduce((best, c, i) => (c > best.count ? { count: c, i } : best), { count: -1, i: 0 });
  const lowest = counts.reduce((best, c, i) => (c < best.count ? { count: c, i } : best), { count: Infinity, i: 0 });
  const stepCount = counts.length || 1;
  const atLabel = i => (times[i] ? `${dayLabel(wallClock(times[i], displayTimeZone).dateKey)} ${hhmm(wallClock(times[i], displayTimeZone))}` : '');

  return {
    displayTimeZone,
    startDate,
    days,
    today: todayKey(displayTimeZone, now),
    dates: dateKeys.map(date => ({ date, label: dayLabel(date) })),
    people,
    coverage: {
      minCoverage,
      stepMinutes,
      // Headcount at each step, for the workload analysis.
      series: includeSeries ? times.map((at, i) => ({ at: at.getTime(), count: counts[i] })) : undefined,
      heat,
      byHour: hourTotals.map((h, hour) => ({ hour: `${String(hour).padStart(2, '0')}:00`, average: h.n ? Math.round((h.sum / h.n) * 10) / 10 : 0, minimum: h.n ? h.min : 0 })),
      gaps,
      low,
      stats: {
        peak: Math.max(0, peak.count), peakAt: atLabel(peak.i),
        lowest: Number.isFinite(lowest.count) ? lowest.count : 0, lowestAt: atLabel(lowest.i),
        uncoveredMinutes: gaps.reduce((s, g) => s + g.minutes, 0),
        belowMinimumMinutes: low.reduce((s, g) => s + g.minutes, 0),
        metMinimumPercent: Math.round((counts.filter(c => c >= minCoverage).length / stepCount) * 1000) / 10,
        agentHours: Math.round(people.reduce((s, p) => s + p.hours, 0) * 10) / 10
      }
    }
  };
}
