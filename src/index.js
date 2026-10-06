import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { getOnShiftMembers } from './domain/shifts.js';
import { normaliseGroup, normaliseOverrides, normaliseMemberSchedules } from './domain/shiftGroups.js';
import { parseRota } from './domain/rota.js';
import { matchUser } from './domain/userMatch.js';
import { decodeBase64File, readDelimitedText, readFirstSheet } from './lib/xlsx.js';
import { matchingRules, ruleMatches } from './engine/rules.js';
import { decideForRule } from './engine/assignment.js';
import { cooldownMinutesForRule, deriveEventTriggers, diffShiftState, executionIsCoolingDown } from './engine/triggers.js';
import { toIssueModel } from './engine/issueModel.js';
import { AUDIT_PREFIX, LEGACY_AUDIT_PREFIX, RETENTION_OPTIONS, auditKey, newestFirst, normaliseRetentionDays } from './engine/audit.js';
import { AUDIT_RETENTION_KEY, getAuditRetentionDays } from './housekeeping.js';
import { setWithTtl } from './lib/kvsTtl.js';
import { assertAdmin } from './lib/admin.js';
import { listByPrefix } from './lib/kvsList.js';
import { countIssues, getIssue, jiraClient, quoteJql, searchIssueKeys } from './lib/jira.js';
import { getRoutingMode } from './routingSettings.js';
import { MIN_COVERAGE_KEY, loadRoster } from './lib/rosterService.js';
import { loadWorkload } from './lib/workloadService.js';
import { APP_VERSION } from './version.js';

const resolver = new Resolver();
const SHIFT_PREFIX = 'shift-group:';
const RULE_PREFIX = 'assignment-rule:';
const ROTATION_PREFIX = 'rotation:';
const EXECUTION_PREFIX = 'execution:';
const SHIFT_STATE_PREFIX = 'shift-state:';
// Shadow mode keeps its own rotation and cooldown state so it never disturbs live routing.
const SHADOW_PREFIX = 'shadow-';
// Upper bound on tickets one rule may touch in a single five-minute scheduled run.
const MAX_ISSUES_PER_RULE_SCAN = 50;
const SHADOW_COOLDOWN_MINUTES = 24 * 60;

const byPriority = (a, b) => (a.priority ?? 1000) - (b.priority ?? 1000);

async function listShiftGroups() { return listByPrefix(SHIFT_PREFIX); }
async function listRules() { return listByPrefix(RULE_PREFIX); }

async function describeUsers(accountIds = [], storedProfiles = []) {
  const stored = Object.fromEntries((storedProfiles || []).filter(p => p?.accountId).map(p => [p.accountId, p.displayName || p.accountId]));
  const unresolved = accountIds.filter(id => !stored[id]);
  const lookedUp = await Promise.all(unresolved.map(async accountId => {
    try {
      const response = await api.asUser().requestJira(route`/rest/api/3/user?accountId=${accountId}`);
      if (!response.ok) return [accountId, accountId];
      const user = await response.json();
      return [accountId, user.displayName || accountId];
    } catch { return [accountId, accountId]; }
  }));
  return { ...stored, ...Object.fromEntries(lookedUp) };
}

function memberProfilesFromPayload(group = {}) {
  return [...new Map((group.memberProfiles || []).filter(p => p?.accountId).map(p => [p.accountId, {
    accountId: String(p.accountId), displayName: String(p.displayName || p.accountId), ...(p.role ? { role: String(p.role).trim() } : {})
  }])).values()];
}

function enrichGroup(group, at = new Date()) {
  const onShiftIds = getOnShiftMembers({ shiftGroup: group, at, overrides: group.overrides || [] });
  const profileMap = Object.fromEntries((group.memberProfiles || []).map(p => [p.accountId, p.displayName]));
  return {
    ...group,
    members: (group.memberAccountIds || []).map(accountId => ({ accountId, displayName: profileMap[accountId] || accountId })),
    onShift: onShiftIds.map(accountId => ({ accountId, displayName: profileMap[accountId] || accountId })),
    memberCount: group.memberAccountIds?.length || 0
  };
}

function profileNames(groups = []) {
  return Object.fromEntries(groups.flatMap(g => g.memberProfiles || []).map(p => [p.accountId, p.displayName]));
}

function projectJql(rule = {}) {
  // Project ids are numeric; anything else is dropped rather than spliced into JQL.
  const ids = (rule.projectIds || []).map(String).filter(id => /^\d+$/.test(id));
  return ids.length ? `project in (${ids.join(',')}) AND ` : '';
}

async function countOpenAssigned(accountIds = [], rule = {}, actor = 'user') {
  const entries = await Promise.all(accountIds.map(async accountId => {
    try {
      return [accountId, await countIssues(`${projectJql(rule)}assignee = ${quoteJql(accountId)} AND statusCategory != Done`, actor)];
    } catch { return [accountId, 0]; }
  }));
  return Object.fromEntries(entries);
}

async function audit(entry) {
  const now = new Date();
  const key = auditKey(now);
  let retentionDays = 90;
  try { retentionDays = await getAuditRetentionDays(); } catch { /* default */ }
  await setWithTtl(key, { id: key.slice(AUDIT_PREFIX.length), createdAt: now.toISOString(), ...entry }, retentionDays);
}

// Cooldown markers only matter for the cooldown window; let KVS expire them a day after it ends.
function markerTtlDays(rule, dryRun) {
  const minutes = dryRun ? Math.max(SHADOW_COOLDOWN_MINUTES, cooldownMinutesForRule(rule)) : cooldownMinutesForRule(rule);
  return Math.ceil(minutes / 1440) + 1;
}

// Everything a rule needs that doesn't depend on the individual issue. Built once per rule so a
// scheduled scan of 50 tickets doesn't repeat the roster and workload lookups 50 times.
async function buildRuleContext({ rule, groups, actor, dryRun = false }) {
  const ruleGroups = groups.filter(g => (rule.shiftGroupIds || []).includes(g.id));
  const at = new Date();
  const eligible = [...new Set(ruleGroups.flatMap(g => getOnShiftMembers({ shiftGroup: g, at, overrides: g.overrides || [] })))];
  const rotationKey = `${dryRun ? SHADOW_PREFIX : ''}${ROTATION_PREFIX}${rule.id}`;
  const [loads, lastAssignedAccountId] = await Promise.all([
    // Workload is only needed to pick (least loaded) or to show in the simulator.
    rule.assignmentStrategy === 'leastLoaded' || actor === 'user' ? countOpenAssigned(eligible, rule, actor) : {},
    kvs.get(rotationKey)
  ]);
  return { rule, eligible, loads, lastAssignedAccountId, rotationKey, names: profileNames(ruleGroups), dryRun };
}

function decide(ctx, jiraIssue, trigger) {
  const issue = toIssueModel(jiraIssue);
  const result = decideForRule({ rule: ctx.rule, issue, eligibleAccountIds: ctx.eligible, loads: ctx.loads, lastAssignedAccountId: ctx.lastAssignedAccountId });
  const name = id => (id ? ctx.names[id] || id : null);
  return {
    issueKey: issue.key,
    trigger,
    matchedRule: ctx.rule,
    currentAssignee: issue.assigneeAccountId ? { accountId: issue.assigneeAccountId, displayName: name(issue.assigneeAccountId) } : null,
    proposedAssignee: result.action === 'assign' ? { accountId: result.assigneeAccountId, displayName: name(result.assigneeAccountId) } : null,
    result,
    eligible: ctx.eligible.map(accountId => ({ accountId, displayName: name(accountId), load: ctx.loads[accountId] || 0 }))
  };
}

async function executeDecision(simulation, ctx, { actor = 'user', source = 'manual-execute', respectCooldown = false } = {}) {
  const rule = simulation.matchedRule;
  if (!rule) return { ...simulation, executed: false };

  const dryRun = ctx.dryRun === true;
  const issueKey = simulation.issueKey;
  const now = new Date();
  const statePrefix = `${dryRun ? SHADOW_PREFIX : ''}${EXECUTION_PREFIX}`;
  const ruleExecutionKey = `${statePrefix}${rule.id}:${issueKey}`;
  const issueExecutionKey = `${statePrefix}issue:${issueKey}`;
  if (respectCooldown) {
    const [lastRuleRun, lastIssueRun] = await Promise.all([kvs.get(ruleExecutionKey), kvs.get(issueExecutionKey)]);
    // Shadow mode never changes the ticket, so the same stale ticket would match again on every scan;
    // log each rule/ticket pair at most once a day.
    const cooldown = dryRun ? Math.max(SHADOW_COOLDOWN_MINUTES, cooldownMinutesForRule(rule)) : cooldownMinutesForRule(rule);
    if (executionIsCoolingDown({ lastExecutedAt: lastRuleRun, now, cooldownMinutes: cooldown }) || executionIsCoolingDown({ lastExecutedAt: lastIssueRun, now, cooldownMinutes: 2 })) {
      return { ...simulation, executed: false, skipped: true, skipReason: 'COOLDOWN' };
    }
  }

  const result = simulation.result || {};
  const auditSource = dryRun ? `shadow:${source}` : source;
  const baseEntry = {
    issueKey, ruleId: rule.id, ruleName: rule.name, trigger: simulation.trigger, reason: result.reason, source: auditSource, dryRun,
    previousAssigneeAccountId: simulation.currentAssignee?.accountId || null,
    previousAssigneeName: simulation.currentAssignee?.displayName || null
  };

  if (!['assign', 'unassign'].includes(result.action)) {
    if (respectCooldown && result.reason === 'NO_ELIGIBLE_AGENT') {
      await setWithTtl(ruleExecutionKey, now.toISOString(), markerTtlDays(rule, dryRun));
      await audit({ ...baseEntry, action: 'none', assigneeAccountId: null, assigneeName: null });
    }
    return { ...simulation, executed: false };
  }

  const accountId = result.action === 'assign' ? result.assigneeAccountId : null;
  if (!dryRun) {
    const res = await jiraClient(actor).requestJira(route`/rest/api/3/issue/${issueKey}/assignee`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Atlassian-Webhook-Trace': `retailinmotion-shift-${rule.id}` },
      body: JSON.stringify({ accountId })
    });
    if (!res.ok) throw new Error(`Unable to update assignee for ${issueKey} (${res.status})`);
  }

  if (accountId) {
    await kvs.set(ctx.rotationKey, accountId);
    ctx.lastAssignedAccountId = accountId;
    ctx.loads[accountId] = (ctx.loads[accountId] || 0) + 1;
  }
  const ttlDays = markerTtlDays(rule, dryRun);
  await Promise.all([setWithTtl(ruleExecutionKey, now.toISOString(), ttlDays), setWithTtl(issueExecutionKey, now.toISOString(), ttlDays)]);
  await audit({ ...baseEntry, action: result.action, assigneeAccountId: accountId, assigneeName: simulation.proposedAssignee?.displayName || null });
  return { ...simulation, executed: !dryRun, shadow: dryRun };
}

async function simulateInternal({ issueKey, trigger = 'issueCreated', actor = 'user' }) {
  const jiraIssue = await getIssue(issueKey, actor);
  const issue = toIssueModel(jiraIssue);
  const matched = matchingRules({ rules: await listRules(), trigger, issue });
  if (!matched.length) return { simulation: { issueKey: issue.key || issueKey, trigger, matchedRule: null, result: { action: 'none', reason: 'NO_MATCHING_RULE' }, eligible: [] } };
  const ctx = await buildRuleContext({ rule: matched[0], groups: await listShiftGroups(), actor });
  return { simulation: decide(ctx, jiraIssue, trigger), ctx };
}

async function routeIssue({ rule, issueKey, trigger, groups, ctxByRule, source, dryRun }) {
  const jiraIssue = await getIssue(issueKey, 'app');
  if (!ruleMatches({ rule, trigger, issue: toIssueModel(jiraIssue) })) return;
  if (!ctxByRule.has(rule.id)) ctxByRule.set(rule.id, await buildRuleContext({ rule, groups, actor: 'app', dryRun }));
  const ctx = ctxByRule.get(rule.id);
  await executeDecision(decide(ctx, jiraIssue, trigger), ctx, { actor: 'app', source, respectCooldown: true });
}

async function scanTemporalRules({ rules, groups, dryRun }) {
  const ctxByRule = new Map();
  for (const rule of rules.filter(r => r.enabled && ['untouched', 'slaThreshold'].includes(r.trigger)).sort(byPriority)) {
    let jql;
    if (rule.trigger === 'untouched') {
      const minutes = Math.max(5, Number(rule.untouchedMinutes || 60));
      jql = `${projectJql(rule)}statusCategory != Done AND updated <= -${minutes}m`;
    } else {
      if (!rule.slaFieldName) continue;
      const minutes = Math.max(1, Number(rule.slaThresholdMinutes || 30));
      const field = quoteJql(rule.slaFieldName);
      jql = `${projectJql(rule)}statusCategory != Done AND ${field} < remaining("${minutes}m") AND ${field} >= remaining("0m")`;
    }
    try {
      for (const key of await searchIssueKeys(jql, 'app', MAX_ISSUES_PER_RULE_SCAN)) {
        await routeIssue({ rule, issueKey: key, trigger: rule.trigger, groups, ctxByRule, source: `scheduled:${rule.trigger}`, dryRun });
      }
    } catch (error) {
      // One bad rule (e.g. an SLA field that no longer exists) must not stop the others.
      console.error(`Scheduled scan failed for rule ${rule.id}`, error);
    }
  }
}

async function scanShiftTransitions({ rules, groups, dryRun }) {
  const now = new Date();
  const boundaryRules = rules.filter(r => r.enabled && ['shiftStart', 'shiftEnd'].includes(r.trigger)).sort(byPriority);
  const ctxByRule = new Map();

  for (const group of groups) {
    const current = getOnShiftMembers({ shiftGroup: group, at: now, overrides: group.overrides || [] });
    const stateKey = `${SHIFT_STATE_PREFIX}${group.id}`;
    const previous = await kvs.get(stateKey);
    await kvs.set(stateKey, { at: now.toISOString(), onShift: current });
    const { baseline, started, ended } = diffShiftState({ previous, current, now });
    if (baseline) continue;

    const forGroup = trigger => boundaryRules.filter(r => r.trigger === trigger && (r.shiftGroupIds || []).includes(group.id));
    const work = [];
    if (ended.length) for (const rule of forGroup('shiftEnd')) work.push({ rule, jql: `${projectJql(rule)}statusCategory != Done AND assignee in (${ended.map(quoteJql).join(',')})` });
    if (started.length) for (const rule of forGroup('shiftStart')) work.push({ rule, jql: `${projectJql(rule)}statusCategory != Done AND assignee is EMPTY` });

    for (const { rule, jql } of work) {
      try {
        for (const key of await searchIssueKeys(jql, 'app', MAX_ISSUES_PER_RULE_SCAN)) {
          await routeIssue({ rule, issueKey: key, trigger: rule.trigger, groups, ctxByRule, source: `scheduled:${rule.trigger}`, dryRun });
        }
      } catch (error) {
        console.error(`Shift boundary scan failed for rule ${rule.id}`, error);
      }
    }
  }
}

resolver.define('getDashboard', async () => {
  await assertAdmin();
  const groups = await listShiftGroups();
  const at = new Date();
  const enriched = [];
  for (const group of groups) {
    const ids = group.memberAccountIds || [];
    const names = await describeUsers(ids, group.memberProfiles || []);
    const memberProfiles = ids.map(accountId => ({ accountId, displayName: names[accountId] || accountId }));
    const changed = JSON.stringify(memberProfiles) !== JSON.stringify(group.memberProfiles || []);
    const persisted = changed ? { ...group, memberProfiles } : group;
    if (changed) await kvs.set(`${SHIFT_PREFIX}${group.id}`, persisted);
    enriched.push(enrichGroup(persisted, at));
  }
  const rules = (await listRules()).sort(byPriority);
  let routingMode = 'off';
  try { routingMode = await getRoutingMode(); } catch { /* shown as off */ }
  return { generatedAt: at.toISOString(), version: APP_VERSION, routingMode, groups: enriched, rules, onShiftCount: enriched.reduce((sum, g) => sum + g.onShift.length, 0), enabledRuleCount: rules.filter(r => r.enabled).length };
});

resolver.define('getRoster', async ({ payload }) => {
  await assertAdmin();
  return loadRoster(payload || {});
});

// Admin only: shows per-agent figures. Reads Jira as the signed-in admin and never writes.
resolver.define('getWorkloadAnalysis', async ({ payload }) => {
  await assertAdmin();
  return loadWorkload(payload || {});
});

resolver.define('setMinCoverage', async ({ payload }) => {
  await assertAdmin();
  const value = Number(payload?.minCoverage);
  if (!Number.isInteger(value) || value < 1 || value > 50) throw new Error('Minimum coverage must be a whole number from 1 to 50.');
  await kvs.set(MIN_COVERAGE_KEY, value);
  return { minCoverage: value };
});

resolver.define('saveShiftGroup', async ({ payload }) => {
  await assertAdmin();
  let raw = payload?.group || {};
  const existing = raw.id ? await kvs.get(`${SHIFT_PREFIX}${raw.id}`) : null;
  // A form that doesn't send per-person hours (older client, or none edited) keeps the stored ones.
  if (raw.memberSchedules === undefined && existing?.memberSchedules) raw = { ...raw, memberSchedules: existing.memberSchedules };
  const group = normaliseGroup(raw);
  group.memberProfiles = memberProfilesFromPayload(raw);
  // Cover/absence entries have their own resolvers; keep what's stored so an edit form opened
  // before a cover was added can't drop it.
  group.overrides = normaliseOverrides(existing ? existing.overrides : raw.overrides, group.memberAccountIds);
  await kvs.set(`${SHIFT_PREFIX}${group.id}`, group);
  return group;
});

resolver.define('setShiftGroupEnabled', async ({ payload }) => {
  await assertAdmin();
  const id = String(payload?.id || '').trim();
  const existing = id ? await kvs.get(`${SHIFT_PREFIX}${id}`) : null;
  if (!existing) throw new Error('Shift group not found.');
  const updated = { ...existing, enabled: payload?.enabled !== false, updatedAt: new Date().toISOString() };
  await kvs.set(`${SHIFT_PREFIX}${id}`, updated);
  return updated;
});

// Cover/absence entries are changed on their own so a save can't overwrite the group's hours or members.
resolver.define('saveShiftOverride', async ({ payload }) => {
  await assertAdmin();
  const groupId = String(payload?.groupId || '').trim();
  const key = `${SHIFT_PREFIX}${groupId}`;
  const group = groupId ? await kvs.get(key) : null;
  if (!group) throw new Error('Shift group not found.');
  const accountId = String(payload?.accountId || '').trim();
  if (!(group.memberAccountIds || []).includes(accountId)) throw new Error('Selected user is not a member of this shift group.');
  const profile = (group.memberProfiles || []).find(p => p.accountId === accountId);
  const [override] = normaliseOverrides([{ accountId, displayName: profile?.displayName, type: payload?.type, startAt: payload?.startAt, endAt: payload?.endAt }], group.memberAccountIds);
  if (!override) throw new Error('Enter a valid start and end time.');
  await kvs.set(key, { ...group, overrides: [...(group.overrides || []), override], updatedAt: new Date().toISOString() });
  return override;
});

resolver.define('deleteShiftOverride', async ({ payload }) => {
  await assertAdmin();
  const groupId = String(payload?.groupId || '').trim();
  const overrideId = String(payload?.overrideId || '').trim();
  const key = `${SHIFT_PREFIX}${groupId}`;
  const group = groupId ? await kvs.get(key) : null;
  if (!group || !overrideId) throw new Error('Shift group and override are required.');
  await kvs.set(key, { ...group, overrides: (group.overrides || []).filter(o => o.id !== overrideId), updatedAt: new Date().toISOString() });
  return { ok: true };
});

async function searchJiraUsers(query) {
  const res = await api.asUser().requestJira(route`/rest/api/3/user/search?query=${query}&maxResults=20`);
  if (!res.ok) return [];
  return res.json();
}

async function matchRotaName(name) {
  let users = await searchJiraUsers(name);
  // Jira may hold a shorter or longer form of the name; fall back to the surname, then the first name.
  for (const part of [name.split(' ').slice(-1)[0], name.split(' ')[0]]) {
    if (matchUser(name, users).match || !part || part.length < 3) break;
    const more = await searchJiraUsers(part);
    users = [...new Map([...users, ...more].map(u => [u.accountId, u])).values()];
  }
  return matchUser(name, users);
}

function readRotaGrid(payload = {}) {
  if (payload.fileData) {
    const name = String(payload.fileName || '').toLowerCase();
    const bytes = decodeBase64File(payload.fileData);
    if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')) return readDelimitedText(Buffer.from(bytes).toString('utf8'));
    return readFirstSheet(bytes);
  }
  if (String(payload.text || '').trim()) return readDelimitedText(payload.text);
  throw new Error('Choose a rota file or paste the rota cells.');
}

resolver.define('previewRota', async ({ payload }) => {
  await assertAdmin();
  const offsetHours = Number(payload?.offsetHours || 0);
  if (!Number.isFinite(offsetHours) || Math.abs(offsetHours) > 14) throw new Error('Time adjustment must be between -14 and +14 hours.');
  const { people, skipped, rowCount } = parseRota(readRotaGrid(payload), { offsetHours });
  const matched = await Promise.all(people.map(async person => ({ ...person, ...(await matchRotaName(person.name).catch(() => ({ match: null, candidates: [] }))) })));
  return { people: matched, skipped, rowCount, offsetHours };
});

// Adds or updates each person's own hours in a shift group, creating the group if needed.
// Members already in the group but not in the import are left as they are.
resolver.define('importRota', async ({ payload }) => {
  await assertAdmin();
  const people = (payload?.people || []).filter(p => p?.accountId && Array.isArray(p.schedule) && p.schedule.length);
  if (!people.length) throw new Error('Nothing to import: select a Jira user for at least one person.');
  const groupId = String(payload?.groupId || '').trim();
  const existing = groupId ? await kvs.get(`${SHIFT_PREFIX}${groupId}`) : null;
  if (groupId && !existing) throw new Error('Shift group not found.');

  const memberAccountIds = [...new Set([...(existing?.memberAccountIds || []), ...people.map(p => String(p.accountId))])];
  const memberSchedules = { ...(existing?.memberSchedules || {}) };
  for (const person of people) memberSchedules[person.accountId] = person.schedule;
  const profiles = new Map((existing?.memberProfiles || []).map(p => [p.accountId, p]));
  for (const person of people) profiles.set(person.accountId, { accountId: String(person.accountId), displayName: String(person.displayName || person.accountId), ...(person.role ? { role: String(person.role).trim() } : {}) });

  const group = normaliseGroup({
    ...(existing || {}),
    id: existing?.id,
    name: existing?.name || payload?.newGroup?.name,
    timezone: existing?.timezone || payload?.newGroup?.timezone || 'Europe/Dublin',
    memberAccountIds,
    recurringSchedule: existing?.recurringSchedule || [],
    memberSchedules: normaliseMemberSchedules(memberSchedules, memberAccountIds)
  });
  group.memberProfiles = [...profiles.values()].filter(p => memberAccountIds.includes(p.accountId));
  group.overrides = normaliseOverrides(existing?.overrides, memberAccountIds);
  await kvs.set(`${SHIFT_PREFIX}${group.id}`, group);
  return { group, imported: people.length };
});

resolver.define('deleteShiftGroup', async ({ payload }) => {
  await assertAdmin();
  const id = String(payload?.id || '').trim();
  if (!id) throw new Error('Shift group id is required.');
  await kvs.delete(`${SHIFT_PREFIX}${id}`);
  return { ok: true };
});

resolver.define('saveAssignmentRule', async ({ payload }) => {
  await assertAdmin();
  const raw = payload?.rule || {};
  const id = String(raw.id || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
  const now = new Date().toISOString();
  const rule = {
    id,
    name: String(raw.name || '').trim(),
    enabled: raw.enabled !== false,
    priority: Math.max(1, Number(raw.priority || 100)),
    trigger: String(raw.trigger || 'issueCreated'),
    projectIds: (raw.projectIds || []).map(String).filter(Boolean),
    conditions: Array.isArray(raw.conditions) ? raw.conditions : [],
    shiftGroupIds: (raw.shiftGroupIds || []).map(String).filter(Boolean),
    assignmentStrategy: String(raw.assignmentStrategy || 'roundRobin'),
    fixedOrder: (raw.fixedOrder || []).map(String).filter(Boolean),
    forceReassign: Boolean(raw.forceReassign),
    shiftEndPolicy: String(raw.shiftEndPolicy || 'reassign'),
    noAgentPolicy: String(raw.noAgentPolicy || 'leaveUnassigned'),
    slaFieldName: String(raw.slaFieldName || '').trim(),
    slaThresholdMinutes: raw.slaThresholdMinutes == null ? null : Number(raw.slaThresholdMinutes),
    untouchedMinutes: raw.untouchedMinutes == null ? null : Number(raw.untouchedMinutes),
    updatedAt: now,
    createdAt: raw.createdAt || now
  };
  if (!rule.name) throw new Error('Rule name is required.');
  if (!rule.shiftGroupIds.length) throw new Error('Select at least one shift group.');
  if (rule.trigger === 'slaThreshold' && !rule.slaFieldName) throw new Error('SLA field name is required for an SLA threshold rule.');
  await kvs.set(`${RULE_PREFIX}${id}`, rule);
  return rule;
});

resolver.define('toggleAssignmentRule', async ({ payload }) => {
  await assertAdmin();
  const id = String(payload?.id || '').trim();
  const existing = await kvs.get(`${RULE_PREFIX}${id}`);
  if (!existing) throw new Error('Assignment rule not found.');
  const updated = { ...existing, enabled: payload?.enabled !== false, updatedAt: new Date().toISOString() };
  await kvs.set(`${RULE_PREFIX}${id}`, updated);
  return updated;
});

resolver.define('deleteAssignmentRule', async ({ payload }) => {
  await assertAdmin();
  const id = String(payload?.id || '').trim();
  if (!id) throw new Error('Rule id is required.');
  await kvs.delete(`${RULE_PREFIX}${id}`);
  return { ok: true };
});

resolver.define('simulateAssignment', async ({ payload }) => {
  await assertAdmin();
  const issueKey = String(payload?.issueKey || '').trim().toUpperCase();
  const trigger = String(payload?.trigger || 'issueCreated');
  if (!issueKey) throw new Error('Issue key is required.');
  return (await simulateInternal({ issueKey, trigger, actor: 'user' })).simulation;
});

resolver.define('executeAssignment', async ({ payload }) => {
  await assertAdmin();
  const issueKey = String(payload?.issueKey || '').trim().toUpperCase();
  const trigger = String(payload?.trigger || 'issueCreated');
  if (!issueKey) throw new Error('Issue key is required.');
  const { simulation, ctx } = await simulateInternal({ issueKey, trigger, actor: 'user' });
  if (!ctx) return { ...simulation, executed: false };
  return executeDecision(simulation, ctx, { actor: 'user', source: 'manual-execute', respectCooldown: false });
});

resolver.define('getAuditLog', async () => {
  await assertAdmin();
  const recent = await listByPrefix(AUDIT_PREFIX, 100);
  if (recent.length >= 100) return recent;
  // Legacy entries were stored oldest-first, so they have to be read in full before sorting.
  const legacy = await listByPrefix(LEGACY_AUDIT_PREFIX, 1000);
  return newestFirst([...recent, ...legacy], 100);
});

resolver.define('getAuditSettings', async () => {
  await assertAdmin();
  return { retentionDays: await getAuditRetentionDays(), options: RETENTION_OPTIONS };
});

resolver.define('setAuditRetention', async ({ payload }) => {
  await assertAdmin();
  const retentionDays = normaliseRetentionDays(payload?.retentionDays);
  await kvs.set(AUDIT_RETENTION_KEY, retentionDays);
  return { retentionDays, options: RETENTION_OPTIONS };
});

resolver.define('health', async () => ({ ok: true, version: APP_VERSION, time: new Date().toISOString() }));

// Core handlers are only called through background.js, which applies the routing mode.
// They default to dry-run so a direct call can never change Jira by accident.
export async function jiraEventHandler(event, _context, { dryRun = true } = {}) {
  const triggers = deriveEventTriggers(event);
  const issueKey = String(event?.issue?.key || '').trim().toUpperCase();
  if (!issueKey || !triggers.length) return;
  const candidates = (await listRules()).filter(r => r.enabled && triggers.includes(r.trigger)).sort(byPriority);
  if (!candidates.length) return;
  const jiraIssue = await getIssue(issueKey, 'app');
  const issue = toIssueModel(jiraIssue);
  const rule = candidates.find(r => ruleMatches({ rule: r, trigger: r.trigger, issue }));
  if (!rule) return;
  const ctx = await buildRuleContext({ rule, groups: await listShiftGroups(), actor: 'app', dryRun });
  await executeDecision(decide(ctx, jiraIssue, rule.trigger), ctx, { actor: 'app', source: `event:${event.eventType}`, respectCooldown: true });
}

export async function scheduledHandler(_request, _context, { dryRun = true } = {}) {
  const [rules, groups] = await Promise.all([listRules(), listShiftGroups()]);
  await scanShiftTransitions({ rules, groups, dryRun });
  await scanTemporalRules({ rules, groups, dryRun });
}

export const handler = resolver.getDefinitions();
