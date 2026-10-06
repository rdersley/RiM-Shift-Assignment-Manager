import Resolver from '@forge/resolver';
import { getOnShiftMembers } from './domain/shifts.js';
import { listByPrefix } from './lib/kvsList.js';
import { loadRoster } from './lib/rosterService.js';

// Read-only resolver for the project-page Shift Schedule. Every Jira user can call it; it never writes.
const resolver = new Resolver();
const SHIFT_PREFIX = 'shift-group:';

function onShiftNow(group, now) {
  const names = Object.fromEntries((group.memberProfiles || []).map(p => [p.accountId, p.displayName || p.accountId]));
  return getOnShiftMembers({ shiftGroup: group, at: now, overrides: group.overrides || [] }).map(accountId => ({ accountId, displayName: names[accountId] || accountId }));
}

resolver.define('getPublicSchedule', async ({ payload }) => {
  const now = new Date();
  const [roster, groups] = await Promise.all([loadRoster(payload || {}), listByPrefix(SHIFT_PREFIX)]);
  const current = groups.filter(g => g?.enabled !== false).map(g => ({ id: g.id, name: g.name, onShift: onShiftNow(g, now) }));
  return { ...roster, generatedAt: now.toISOString(), onShift: current, onShiftCount: new Set(current.flatMap(g => g.onShift.map(u => u.accountId))).size };
});

export const handler = resolver.getDefinitions();
