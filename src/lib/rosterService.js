import { kvs } from '@forge/kvs';
import { addDays, buildRoster, todayKey } from '../domain/roster.js';
import { listByPrefix } from './kvsList.js';

export const MIN_COVERAGE_KEY = 'settings:min-coverage';
export const DISPLAY_ZONES = [
  { label: 'Irish time', value: 'Europe/Dublin' },
  { label: 'Manila time', value: 'Asia/Manila' },
  { label: 'UTC', value: 'UTC' }
];
const RANGES = [1, 7, 28];

export async function getMinCoverage() {
  const value = Number(await kvs.get(MIN_COVERAGE_KEY));
  return Number.isInteger(value) && value >= 1 && value <= 50 ? value : 2;
}

// Day view opens on today; week and four-week views open on this week's Monday, like the rota.
function defaultStart(timeZone, days) {
  const today = todayKey(timeZone);
  if (days === 1) return today;
  const [y, m, d] = today.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(today, -((weekday + 6) % 7));
}

// Shared by the admin page and the read-only project page.
export async function loadRoster(payload = {}) {
  const displayTimeZone = DISPLAY_ZONES.some(z => z.value === payload.displayTimeZone) ? payload.displayTimeZone : 'Europe/Dublin';
  const days = RANGES.includes(Number(payload.days)) ? Number(payload.days) : 7;
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.startDate || '')) ? payload.startDate : defaultStart(displayTimeZone, days);
  const groupId = String(payload.groupId || '');
  const [allGroups, minCoverage] = await Promise.all([listByPrefix('shift-group:'), getMinCoverage()]);
  const enabled = allGroups.filter(g => g?.enabled !== false);
  const groups = groupId ? enabled.filter(g => g.id === groupId) : enabled;
  return {
    ...buildRoster({ groups, startDate, days, displayTimeZone, minCoverage }),
    groupId,
    groupOptions: enabled.map(g => ({ label: g.name, value: g.id })),
    zoneOptions: DISPLAY_ZONES
  };
}
