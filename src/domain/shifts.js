const DAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];

function minutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`Invalid time: ${hhmm}`);
  }
  return h * 60 + m;
}

const formatters = new Map();
function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  }
  return formatters.get(timeZone);
}

// Weekday and minute of day at `date` in `timeZone`. Roster calculations reuse one result for every
// member of a group, so the Intl call is made once per time step rather than once per person.
export function localParts(date, timeZone) {
  const obj = Object.fromEntries(formatterFor(timeZone).formatToParts(date).map(p => [p.type, p.value]));
  return {
    day: obj.weekday.toLowerCase().slice(0, 3),
    minuteOfDay: Number(obj.hour) * 60 + Number(obj.minute)
  };
}

function previousDay(day) {
  const i = DAY_KEYS.indexOf(day);
  return DAY_KEYS[(i + 6) % 7];
}

function scheduleMatches(schedule, day, minuteOfDay) {
  const start = minutes(schedule.start);
  const end = minutes(schedule.end);
  if (start === end) return false;
  if (end > start) {
    return schedule.day === day && minuteOfDay >= start && minuteOfDay < end;
  }
  return (schedule.day === day && minuteOfDay >= start) ||
    (schedule.day === previousDay(day) && minuteOfDay < end);
}

function overrideApplies(override, accountId, at) {
  if (override.accountId !== accountId) return false;
  const start = new Date(override.startAt);
  const end = new Date(override.endAt);
  return at >= start && at < end;
}

// A member's own hours, when set, replace the group's hours for that member.
export function scheduleForMember(shiftGroup, accountId) {
  const personal = shiftGroup?.memberSchedules?.[accountId];
  return personal?.length ? personal : (shiftGroup?.recurringSchedule || []);
}

// Recurring hours only, ignoring cover/absence. `parts` comes from localParts for the group's timezone.
export function isScheduledAt(shiftGroup, accountId, parts) {
  return scheduleForMember(shiftGroup, accountId).some(s => scheduleMatches(s, parts.day, parts.minuteOfDay));
}

// 'exclude' wins over 'include'; null when no cover/absence entry applies.
export function overrideStateAt(overrides = [], accountId, at) {
  const active = overrides.filter(o => overrideApplies(o, accountId, at));
  if (active.some(o => o.type === 'exclude')) return 'exclude';
  if (active.some(o => o.type === 'include')) return 'include';
  return null;
}

export function isMemberOnShift({ shiftGroup, accountId, at = new Date(), overrides = [], parts }) {
  if (!shiftGroup?.enabled || !shiftGroup.memberAccountIds?.includes(accountId)) return false;
  const override = overrideStateAt(overrides, accountId, at);
  if (override === 'exclude') return false;
  if (override === 'include') return true;
  return isScheduledAt(shiftGroup, accountId, parts || localParts(at, shiftGroup.timezone || 'UTC'));
}

export function getOnShiftMembers({ shiftGroup, at = new Date(), overrides = [] }) {
  const parts = localParts(at, shiftGroup.timezone || 'UTC');
  return (shiftGroup.memberAccountIds || []).filter(accountId =>
    isMemberOnShift({ shiftGroup, accountId, at, overrides, parts })
  );
}
