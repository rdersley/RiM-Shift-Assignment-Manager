import api, { route } from '@forge/api';
import { buildRoster } from '../domain/roster.js';
import { analyseWorkload } from '../domain/workload.js';
import { listByPrefix } from './kvsList.js';
import { searchIssues } from './jira.js';

const PERIODS = [7, 30, 90];
// Enough for a busy service desk over a month while staying inside the resolver time limit.
const MAX_ISSUES = 1000;
const SLA_SCHEMA = 'com.atlassian.servicedesk:sd-sla-field';
const REQUEST_TYPE_SCHEMA = 'com.atlassian.servicedesk:vp-origin';
const DAY = 86_400_000;

async function getJson(path) {
  const res = await api.asUser().requestJira(path);
  if (!res.ok) throw new Error(`Jira request failed (${res.status})`);
  return res.json();
}

function slaValue(value) {
  if (!value || typeof value !== 'object') return null;
  const cycle = value.ongoingCycle || (value.completedCycles || []).slice(-1)[0];
  if (!cycle) return null;
  return { breached: Boolean(cycle.breached), elapsedMs: cycle.elapsedTime?.millis ?? null };
}

// Turns a Jira issue (with changelog) into the shape analyseWorkload expects.
export function normaliseIssue(issue, { categoryOf, firstResponseField, resolutionField, requestTypeField }) {
  const f = issue.fields || {};
  const transitions = (issue.changelog?.histories || []).flatMap(h => (h.items || [])
    .filter(item => item.fieldId === 'status' || item.field === 'status')
    .map(item => ({ at: Date.parse(h.created), toCategory: categoryOf(item.to) })))
    .filter(t => Number.isFinite(t.at) && t.toCategory);
  return {
    key: issue.key,
    createdAt: Date.parse(f.created),
    resolvedAt: f.resolutiondate ? Date.parse(f.resolutiondate) : null,
    priority: f.priority?.name || null,
    issueType: f.issuetype?.name || null,
    requestType: requestTypeField ? f[requestTypeField]?.requestType?.name || null : null,
    assigneeAccountId: f.assignee?.accountId || null,
    assigneeName: f.assignee?.displayName || null,
    statusCategory: f.status?.statusCategory?.key || categoryOf(f.status?.id) || 'new',
    transitions,
    sla: { firstResponse: firstResponseField ? slaValue(f[firstResponseField]) : null, resolution: resolutionField ? slaValue(f[resolutionField]) : null }
  };
}

export async function loadWorkload(payload = {}, now = new Date()) {
  const days = PERIODS.includes(Number(payload.days)) ? Number(payload.days) : 30;
  const projectIds = (payload.projectIds || []).map(String).filter(id => /^\d+$/.test(id));
  if (!projectIds.length) throw new Error('Choose at least one project.');
  const timeZone = 'Europe/Dublin';
  const period = { from: now.getTime() - days * DAY, to: now.getTime() };

  const [statuses, fieldList] = await Promise.all([getJson(route`/rest/api/3/status`), getJson(route`/rest/api/3/field`)]);
  const categories = Object.fromEntries((statuses || []).map(s => [String(s.id), s.statusCategory?.key]));
  const categoryOf = id => categories[String(id)] || null;
  const slaFields = (fieldList || []).filter(x => x.schema?.custom === SLA_SCHEMA);
  const firstResponseField = slaFields.find(x => /first response/i.test(x.name))?.id;
  const resolutionField = slaFields.find(x => /resolution/i.test(x.name))?.id;
  const requestTypeField = (fieldList || []).find(x => x.schema?.custom === REQUEST_TYPE_SCHEMA)?.id;

  const jql = `project in (${projectIds.join(',')}) AND (created >= -${days}d OR resolved >= -${days}d OR statusCategory != Done) ORDER BY created DESC`;
  const fields = ['created', 'resolutiondate', 'status', 'assignee', 'priority', 'issuetype', firstResponseField, resolutionField, requestTypeField].filter(Boolean);
  const { issues, truncated } = await searchIssues(jql, { fields, expand: 'changelog', max: MAX_ISSUES, actor: 'user' });
  const normalised = issues.map(issue => normaliseIssue(issue, { categoryOf, firstResponseField, resolutionField, requestTypeField })).filter(i => Number.isFinite(i.createdAt));

  // Staffing from the current shift groups, over the same period.
  const groupId = String(payload.groupId || '');
  const enabledGroups = (await listByPrefix('shift-group:')).filter(g => g?.enabled !== false);
  const groups = enabledGroups.filter(g => !groupId || g.id === groupId);
  const startDate = new Date(period.from).toLocaleDateString('en-CA', { timeZone });
  const roster = buildRoster({ groups, startDate, days: days + 1, displayTimeZone: timeZone, stepMinutes: 15, includeSeries: true });
  const rosteredHours = {};
  const names = {};
  for (const person of roster.people) {
    rosteredHours[person.accountId] = (rosteredHours[person.accountId] || 0) + person.hours;
    names[person.accountId] = person.displayName;
  }
  const series = roster.coverage.series.filter(s => s.at >= period.from && s.at < period.to);
  // People's hours cover whole days; scale to the exact period so per-hour rates line up.
  const scale = days / (days + 1);
  for (const id of Object.keys(rosteredHours)) rosteredHours[id] = Math.round(rosteredHours[id] * scale * 10) / 10;

  return {
    days, projectIds, groupId, timeZone,
    from: new Date(period.from).toISOString(), to: new Date(period.to).toISOString(),
    sampled: truncated, issueCount: normalised.length, maxIssues: MAX_ISSUES,
    slaFields: { firstResponse: Boolean(firstResponseField), resolution: Boolean(resolutionField) },
    groupOptions: enabledGroups.map(g => ({ label: g.name, value: g.id })),
    ...analyseWorkload({ issues: normalised, staffing: { stepMinutes: 15, series, rosteredHours, names }, period, timeZone, now: now.getTime() })
  };
}

