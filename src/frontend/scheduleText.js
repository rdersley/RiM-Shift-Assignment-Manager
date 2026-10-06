export const WEEK = [
  { label: 'Monday', value: 'mon' }, { label: 'Tuesday', value: 'tue' }, { label: 'Wednesday', value: 'wed' },
  { label: 'Thursday', value: 'thu' }, { label: 'Friday', value: 'fri' }, { label: 'Saturday', value: 'sat' }, { label: 'Sunday', value: 'sun' }
];

const sameHours = schedule => schedule.length > 0 && schedule.every(s => s.start === schedule[0].start && s.end === schedule[0].end);

// "MON, TUE · 09:00–17:00" when every day matches, otherwise each day with its own hours.
export function scheduleSummary(schedule = []) {
  if (!schedule.length) return 'No working days';
  if (sameHours(schedule)) return `${schedule.map(s => s.day.toUpperCase()).join(', ')} · ${schedule[0].start}–${schedule[0].end}`;
  return schedule.map(s => `${s.day.toUpperCase()} ${s.start}–${s.end}`).join(' · ');
}
