// Pure helpers for Timeline.jsx (kept separate so they can be unit-tested).

const minutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// What a person is doing on a date, as a key that consecutive equal days can be merged on.
export function dayEntry(cell) {
  const shifts = (cell?.shifts || []).filter(s => !s.continued);
  if (shifts.length) {
    const s = shifts[0];
    const kind = s.kind === 'cover' ? 'cover' : (s.band || 'day');
    const text = `${s.start} – ${s.end}${s.overnight ? ' +1' : ''}${shifts.length > 1 ? ` (+${shifts.length - 1})` : ''}`;
    return { key: `${kind}|${text}`, kind, text };
  }
  if (cell?.absent?.length) return { key: 'absent', kind: 'absent', text: 'Absent' };
  return null;
}

// [{ from: dayIndex, span, entry }] for one person across the visible dates.
export function mergedBars(person, dates) {
  const bars = [];
  dates.forEach((d, i) => {
    const entry = dayEntry(person.cells[d.date]);
    const last = bars[bars.length - 1];
    if (entry && last && last.entry.key === entry.key && last.from + last.span === i) last.span += 1;
    else if (entry) bars.push({ from: i, span: 1, entry });
  });
  return bars;
}

// Exact-hour bars for the day view.
export function hourBars(person, date) {
  const cell = person.cells[date];
  const bars = (cell?.shifts || []).map(s => {
    const start = s.continued ? 0 : minutes(s.start);
    const end = s.overnight || s.end === '…' ? 1440 : minutes(s.end);
    return { start, end: Math.max(end, start + 15), kind: s.kind === 'cover' ? 'cover' : (s.band || 'day'), text: s.continued ? `until ${s.end}` : `${s.start} – ${s.end}`, tip: s.overnight ? `${s.start} to ${s.end} the next day` : `${s.start} to ${s.end}` };
  });
  for (const a of cell?.absent || []) bars.push({ start: minutes(a.start), end: Math.max(minutes(a.end) || 1440, minutes(a.start) + 15), kind: 'absent', text: 'Absent', tip: `Absent ${a.start}–${a.end}` });
  return bars.sort((a, b) => a.start - b.start);
}
