const VALID_DAYS = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `shift-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function normaliseSchedule(input = {}) {
  const days = [...new Set((input.days || []).filter(day => VALID_DAYS.has(day)))];
  const start = String(input.start || '09:00');
  const end = String(input.end || '17:00');
  if (!TIME_RE.test(start)) throw new Error('Start time must be HH:mm.');
  if (!TIME_RE.test(end)) throw new Error('End time must be HH:mm.');
  return normaliseEntries(days.map(day => ({ day, start, end })));
}

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

// Per-day working windows, e.g. Mon–Thu 09:00–17:00 and Fri 09:00–13:00. An end earlier than the start
// is an overnight shift. A day may have more than one window (a split shift).
export function normaliseEntries(entries = []) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const day = String(entry?.day || '');
    if (!VALID_DAYS.has(day)) continue;
    const start = String(entry.start || '');
    const end = String(entry.end || '');
    if (!TIME_RE.test(start)) throw new Error(`${DAY_NAMES[day]}: start time must be HH:mm.`);
    if (!TIME_RE.test(end)) throw new Error(`${DAY_NAMES[day]}: end time must be HH:mm.`);
    if (start === end) throw new Error(`${DAY_NAMES[day]}: start and end time can't be the same.`);
    const id = `${day}|${start}|${end}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ day, start, end });
  }
  return result.sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || a.start.localeCompare(b.start));
}

export function normaliseGroup(input = {}, now = new Date()) {
  const id = input.id || makeId();
  const memberAccountIds = [...new Set((input.memberAccountIds || []).map(String).map(v => v.trim()).filter(Boolean))];
  const stamp = now.toISOString();
  const name = String(input.name || '').trim();
  const timezone = String(input.timezone || 'Europe/Dublin').trim();
  // `schedule` is the "same hours every day" shape; `recurringSchedule` carries per-day hours.
  const recurringSchedule = input.schedule ? normaliseSchedule(input.schedule) : normaliseEntries(input.recurringSchedule || []);
  const memberSchedules = normaliseMemberSchedules(input.memberSchedules, memberAccountIds);

  if (!name) throw new Error('Shift group name is required.');
  if (!memberAccountIds.length) throw new Error('Select at least one Jira user.');
  // Group hours are optional when every member has their own (e.g. an imported rota).
  if (!recurringSchedule.length && !memberAccountIds.every(id => memberSchedules[id])) {
    throw new Error(Object.keys(memberSchedules).length
      ? 'Select group working days for members without their own hours.'
      : 'Select at least one working day.');
  }

  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(now);
  } catch {
    throw new Error('A valid IANA timezone is required.');
  }

  return {
    id,
    name,
    timezone,
    enabled: input.enabled !== false,
    memberAccountIds,
    recurringSchedule,
    memberSchedules,
    createdAt: input.createdAt || stamp,
    updatedAt: stamp
  };
}

// { accountId: [{ day, start, end }] } for current members only; empty schedules are dropped.
export function normaliseMemberSchedules(input, memberAccountIds = []) {
  if (!input || typeof input !== 'object') return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([accountId]) => memberAccountIds.includes(accountId))
    .map(([accountId, entries]) => [accountId, normaliseEntries(Array.isArray(entries) ? entries : [])])
    .filter(([, entries]) => entries.length));
}

// Cover/absence entries come from the admin UI; keep only well-formed ones for current members.
export function normaliseOverrides(input, memberAccountIds = []) {
  if (!Array.isArray(input)) return [];
  return input.flatMap(raw => {
    const accountId = String(raw?.accountId || '').trim();
    const startAt = new Date(raw?.startAt);
    const endAt = new Date(raw?.endAt);
    if (!accountId || !memberAccountIds.includes(accountId)) return [];
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) return [];
    return [{
      id: String(raw.id || makeId()),
      accountId,
      displayName: String(raw.displayName || accountId),
      type: raw.type === 'exclude' ? 'exclude' : 'include',
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      createdAt: raw.createdAt || new Date().toISOString()
    }];
  });
}
