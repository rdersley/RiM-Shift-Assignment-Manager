import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyseWorkload, hourOfWeek, median, percentile, ticketTimings } from '../src/domain/workload.js';
import { normaliseIssue } from '../src/lib/workloadService.js';

const backend = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const service = await readFile(new URL('../src/lib/workloadService.js', import.meta.url), 'utf8');

const H = 3_600_000;
// Monday 5 Oct 2026 00:00 Irish time (UTC+1).
const MON = Date.parse('2026-10-04T23:00:00Z');
const period = { from: MON, to: MON + 7 * 24 * H };
const now = period.to;

// Agents on shift every 15 minutes: `count(hourOfWeek)` decides how many.
function staffing(count, rosteredHours = {}) {
  const series = [];
  for (let t = period.from; t < period.to; t += 15 * 60_000) series.push({ at: t, count: count(Math.floor((t - period.from) / H) % 168) });
  return { stepMinutes: 15, series, rosteredHours, names: {} };
}
const ticket = (createdAt, extra = {}) => ({ key: `T-${createdAt}`, createdAt, resolvedAt: null, priority: 'Medium', issueType: 'Service request', statusCategory: 'new', transitions: [], sla: {}, ...extra });

test('median and percentile', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test('hour of week is Monday-based in Irish time', () => {
  assert.equal(hourOfWeek(new Date(MON), 'Europe/Dublin'), 0);
  assert.equal(hourOfWeek(new Date(MON + 33 * H), 'Europe/Dublin'), 33); // Tue 09:00
});

test('ticket timings: pickup, time in progress (excluding waits) and resolution', () => {
  const t = ticketTimings({
    createdAt: 0, resolvedAt: 10 * H,
    transitions: [{ at: 1 * H, toCategory: 'indeterminate' }, { at: 4 * H, toCategory: 'new' }, { at: 6 * H, toCategory: 'indeterminate' }, { at: 10 * H, toCategory: 'done' }]
  }, 20 * H);
  assert.equal(t.pickupMs, 1 * H);
  assert.equal(t.inProgressMs, 7 * H);
  assert.equal(t.resolutionMs, 10 * H);
  assert.equal(t.waitingMs, null);
});

test('an untouched open ticket is waiting, with no pickup time', () => {
  const t = ticketTimings({ createdAt: 0, resolvedAt: null, transitions: [] }, 5 * H);
  assert.equal(t.pickupMs, null);
  assert.equal(t.waitingMs, 5 * H);
});

test('a ticket resolved straight from To Do counts resolution as its pickup', () => {
  assert.equal(ticketTimings({ createdAt: 0, resolvedAt: 2 * H, transitions: [{ at: 2 * H, toCategory: 'done' }] }, 3 * H).pickupMs, 2 * H);
});

test('tickets arriving when nobody is rostered are flagged first', () => {
  // Agents 09:00–17:00 every day; tickets also arrive at 02:00 every night.
  const issues = [];
  for (let d = 0; d < 7; d += 1) for (const h of [2, 2, 10, 11, 14]) issues.push(ticket(MON + (d * 24 + h) * H + 60_000));
  const result = analyseWorkload({ issues, staffing: staffing(i => (i % 24 >= 9 && i % 24 < 17 ? 2 : 0)), period, now });
  // Low volume: hours are pooled into weekdays and weekends.
  assert.equal(result.recommendations[0].kind, 'unstaffed');
  assert.deepEqual(result.recommendations.filter(r => r.kind === 'unstaffed').map(r => r.title), ['Nobody rostered Weekdays 02:00–03:00', 'Nobody rostered Weekends 02:00–03:00']);
  assert.ok(result.recommendations[0].detail.startsWith('10 ticket(s) arrived'));
});

test('a busy hour with too few agents is flagged as understaffed', () => {
  const issues = [];
  for (let d = 0; d < 7; d += 1) {
    for (let k = 0; k < 8; k += 1) issues.push(ticket(MON + (d * 24 + 9) * H + k * 60_000)); // rush at 09:00
    for (const h of [11, 13, 15]) issues.push(ticket(MON + (d * 24 + h) * H));
  }
  const result = analyseWorkload({ issues, staffing: staffing(i => (i % 24 >= 8 && i % 24 < 18 ? 2 : 0)), period, now });
  const busy = result.recommendations.filter(r => r.kind === 'understaffed');
  assert.deepEqual(busy.map(r => r.title), ['Busy for the cover: Weekdays 09:00–10:00', 'Busy for the cover: Weekends 09:00–10:00']);
});

test('a well-staffed quiet stretch is offered as cover to move', () => {
  const issues = [];
  for (let d = 0; d < 7; d += 1) for (let h = 8; h < 12; h += 1) for (let k = 0; k < 4; k += 1) issues.push(ticket(MON + (d * 24 + h) * H + k * 60_000));
  const result = analyseWorkload({ issues, staffing: staffing(i => (i % 24 >= 8 && i % 24 < 20 ? 4 : 0)), period, now });
  assert.ok(result.recommendations.some(r => r.kind === 'quiet' && /12:00–20:00/.test(r.title)));
});

test('slow pickup for tickets created late in the day is called out', () => {
  const issues = [];
  for (let d = 0; d < 7; d += 1) {
    for (const h of [9, 10, 11, 12]) issues.push(ticket(MON + (d * 24 + h) * H, { transitions: [{ at: MON + (d * 24 + h) * H + 15 * 60_000, toCategory: 'indeterminate' }], statusCategory: 'indeterminate' }));
    issues.push(ticket(MON + (d * 24 + 18) * H, { transitions: [{ at: MON + (d * 24 + 18 + 15) * H, toCategory: 'indeterminate' }], statusCategory: 'indeterminate' }));
  }
  const result = analyseWorkload({ issues, staffing: staffing(i => (i % 24 >= 8 && i % 24 < 19 ? 2 : 0)), period, now });
  assert.ok(result.recommendations.some(r => r.kind === 'slowPickup' && /18:00–19:00/.test(r.title)));
});

test('a growing backlog and agents missing from the rota are reported', () => {
  const issues = Array.from({ length: 20 }, (_, i) => ticket(MON + (i * 5 + 10) * H));
  for (let i = 0; i < 3; i += 1) issues.push(ticket(MON + i * H, { resolvedAt: MON + (i + 2) * H, statusCategory: 'done', assigneeAccountId: 'ghost', assigneeName: 'Ghost Agent' }));
  const result = analyseWorkload({ issues, staffing: staffing(() => 1, { a: 168 }), period, now });
  assert.ok(result.recommendations.some(r => r.kind === 'backlog'));
  const offRota = result.recommendations.find(r => r.kind === 'offRota');
  assert.match(offRota.detail, /Ghost Agent/);
  assert.equal(result.agents.find(a => a.accountId === 'ghost').onRota, false);
});

test('agent rows combine resolved work with rostered hours', () => {
  const issues = [0, 1, 2, 3].map(i => ticket(MON + i * H, { resolvedAt: MON + (i + 1) * H, statusCategory: 'done', assigneeAccountId: 'a', assigneeName: 'Agent A', transitions: [{ at: MON + i * H + 30 * 60_000, toCategory: 'indeterminate' }, { at: MON + (i + 1) * H, toCategory: 'done' }] }));
  const result = analyseWorkload({ issues, staffing: staffing(() => 1, { a: 40 }), period, now });
  const a = result.agents.find(x => x.accountId === 'a');
  assert.deepEqual([a.resolved, a.rosteredHours, a.resolvedPer10Hours, a.medianResolutionHours, a.medianInProgressHours], [4, 40, 1, 1, 0.5]);
});

test('SLA breach rates and the priority breakdown', () => {
  const issues = [
    ticket(MON + H, { priority: 'High', sla: { resolution: { breached: true } } }),
    ticket(MON + 2 * H, { priority: 'High', sla: { resolution: { breached: false } } }),
    ticket(MON + 3 * H, { priority: 'Low', sla: { resolution: { breached: false }, firstResponse: { breached: true } } })
  ];
  const result = analyseWorkload({ issues, staffing: staffing(() => 1), period, now });
  assert.equal(result.summary.resolutionBreachPercent, 33.3);
  assert.equal(result.summary.firstResponseBreachPercent, 100);
  assert.equal(result.byPriority.find(p => p.label === 'High').resolutionSlaBreachPercent, 50);
});

test('load heat marks tickets with nobody rostered as unstaffed (null load)', () => {
  const result = analyseWorkload({ issues: [ticket(MON + 3 * H)], staffing: staffing(() => 0), period, now });
  assert.equal(result.heat[0].hours[3].load, null);
  assert.equal(result.heat[0].hours[4].load, 0);
});

test('Jira issues are normalised from fields, changelog and SLA values', () => {
  const issue = normaliseIssue({
    key: 'SD-1',
    fields: {
      created: '2026-10-05T08:00:00.000+0100', resolutiondate: '2026-10-05T12:00:00.000+0100',
      status: { id: '3', statusCategory: { key: 'done' } }, assignee: { accountId: 'a', displayName: 'Agent A' }, priority: { name: 'High' }, issuetype: { name: 'Incident' },
      customfield_1: { requestType: { name: 'Report a problem' } },
      customfield_2: { completedCycles: [{ breached: true, elapsedTime: { millis: 5000 } }] }
    },
    changelog: { histories: [{ created: '2026-10-05T09:00:00.000+0100', items: [{ field: 'status', fieldId: 'status', from: '1', to: '2' }, { field: 'assignee' }] }] }
  }, { categoryOf: id => ({ 1: 'new', 2: 'indeterminate', 3: 'done' })[id], resolutionField: 'customfield_2', requestTypeField: 'customfield_1' });
  assert.equal(issue.requestType, 'Report a problem');
  assert.deepEqual(issue.transitions, [{ at: Date.parse('2026-10-05T08:00:00Z'), toCategory: 'indeterminate' }]);
  assert.deepEqual(issue.sla.resolution, { breached: true, elapsedMs: 5000 });
  assert.equal(issue.statusCategory, 'done');
});

test('workload analysis is admin-only and never writes', () => {
  const start = backend.indexOf("resolver.define('getWorkloadAnalysis'");
  assert.ok(start > 0);
  assert.ok(backend.slice(start, start + 120).includes('await assertAdmin()'));
  assert.ok(!/kvs\.(set|delete)|method: 'PUT'/.test(service));
});

test('with enough tickets each hour of the week is judged on its own', () => {
  const issues = [];
  // Steady 5 an hour all week, plus a Monday 09:00 rush with the same staffing.
  for (let i = 0; i < 168; i += 1) for (let k = 0; k < 5; k += 1) issues.push(ticket(MON + i * H + k * 60_000));
  for (let k = 0; k < 20; k += 1) issues.push(ticket(MON + 9 * H + k * 60_000 + 30_000));
  const result = analyseWorkload({ issues, staffing: staffing(() => 3), period, now });
  assert.deepEqual(result.recommendations.filter(r => r.kind === 'understaffed').map(r => r.title), ['Busy for the cover: Mon 09:00–10:00']);
});

test('one stray ticket does not flag a window', () => {
  const issues = [ticket(MON + 3 * H), ...Array.from({ length: 30 }, (_, i) => ticket(MON + (10 + (i % 6)) * H + i * 60_000))];
  const result = analyseWorkload({ issues, staffing: staffing(i => (i % 24 >= 9 && i % 24 < 17 ? 2 : 0)), period, now });
  assert.equal(result.recommendations.filter(r => r.kind === 'unstaffed').length, 0);
});

test('an overnight gap is reported as one window across midnight', () => {
  const issues = [];
  for (let d = 0; d < 7; d += 1) for (const h of [22, 23, 0, 1, 10, 11, 12]) issues.push(ticket(MON + (d * 24 + h) * H + 60_000));
  const result = analyseWorkload({ issues, staffing: staffing(i => (i % 24 >= 8 && i % 24 < 20 ? 2 : 0)), period, now });
  assert.ok(result.recommendations.some(r => r.title === 'Nobody rostered Weekdays 20:00–08:00' || r.title === 'Nobody rostered Weekdays 22:00–02:00'));
});

test('each kind is capped, with a pointer to the rest', () => {
  const issues = [];
  for (let d = 0; d < 7; d += 1) for (let h = 0; h < 24; h += 2) for (let k = 0; k < 3; k += 1) issues.push(ticket(MON + (d * 24 + h) * H + k * 60_000));
  // Agents only on odd hours: every even hour is an uncovered window.
  const result = analyseWorkload({ issues, staffing: staffing(i => (i % 2 ? 1 : 0)), period, now });
  assert.equal(result.recommendations.filter(r => r.kind === 'unstaffed').length, 5);
  assert.ok(result.recommendations.some(r => r.kind === 'more' && /uncovered window/.test(r.title)));
});

test('created and resolved are both profiled by hour of day', () => {
  const issues = [];
  for (let d = 0; d < 7; d += 1) {
    // Two created at 09:00 each day, resolved at 14:00.
    for (let k = 0; k < 2; k += 1) issues.push(ticket(MON + (d * 24 + 9) * H + k * 60_000, { resolvedAt: MON + (d * 24 + 14) * H, statusCategory: 'done' }));
  }
  const result = analyseWorkload({ issues, staffing: staffing(() => 2), period, now });
  const at = hour => result.byHourOfDay.find(h => h.hour === hour);
  assert.equal(at('09:00').ticketsPerDay, 2);
  assert.equal(at('09:00').resolvedPerDay, 0);
  assert.equal(at('14:00').resolvedPerDay, 2);
  assert.deepEqual([result.flow.peakCreatedHour, result.flow.peakResolvedHour], ['09:00', '14:00']);
  assert.deepEqual(result.flow.buildingHours, ['09:00']);
});
