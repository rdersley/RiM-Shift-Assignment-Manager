import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ruleMatches } from '../src/engine/rules.js';
import { decideForRule } from '../src/engine/assignment.js';
import { diffShiftState } from '../src/engine/triggers.js';
import { findRequestTypeId, toIssueModel } from '../src/engine/issueModel.js';
import { AUDIT_PREFIX, LEGACY_AUDIT_PREFIX, auditKey } from '../src/engine/audit.js';
import { normaliseOverrides } from '../src/domain/shiftGroups.js';
import { APP_VERSION } from '../src/version.js';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const backend = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const jira = await readFile(new URL('../src/lib/jira.js', import.meta.url), 'utf8');

function rule(overrides = {}) {
  return { id: 'r1', name: 'test', enabled: true, priority: 100, trigger: 'issueCreated', projectIds: [], conditions: [], assignmentStrategy: 'roundRobin', ...overrides };
}
const issueWith = fields => ({ projectId: '1', assigneeAccountId: null, labels: [], componentIds: [], fields });

test('app version constant matches package.json', () => {
  assert.equal(APP_VERSION, pkg.version);
});

// --- Jira search API ---------------------------------------------------------------------------

test('backend no longer calls the removed /rest/api/3/search endpoint', () => {
  for (const source of [backend, jira]) assert.ok(!/\/rest\/api\/3\/search\?/.test(source), 'legacy search endpoint still in use');
  assert.match(jira, /\/rest\/api\/3\/search\/jql\?/);
  assert.match(jira, /\/rest\/api\/3\/search\/approximate-count/);
});

// --- Custom field conditions -------------------------------------------------------------------

test('single-select custom field matches on the option value', () => {
  const issue = issueWith({ customfield_1: { self: 'x', value: 'Ryanair', id: '10021' } });
  assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'customfield_1', operator: 'equals', value: 'Ryanair' }] }), trigger: 'issueCreated', issue }), true);
  assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'customfield_1', operator: 'equals', value: 'Aer Lingus' }] }), trigger: 'issueCreated', issue }), false);
});

test('multi-select custom field matches when any option equals the value', () => {
  const issue = issueWith({ customfield_1: [{ value: 'POS' }, { value: 'Hardware' }] });
  assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'customfield_1', operator: 'equals', value: 'hardware' }] }), trigger: 'issueCreated', issue }), true);
});

test('cascading select matches parent or child', () => {
  const issue = issueWith({ customfield_1: { value: 'Europe', child: { value: 'Dublin' } } });
  assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'customfield_1', operator: 'equals', value: 'Dublin' }] }), trigger: 'issueCreated', issue }), true);
});

test('user custom field matches on account id or display name', () => {
  const issue = issueWith({ customfield_1: { accountId: 'abc-123', displayName: 'Pat Doe' } });
  for (const value of ['abc-123', 'Pat Doe']) {
    assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'customfield_1', operator: 'equals', value }] }), trigger: 'issueCreated', issue }), true);
  }
});

test('notEquals on an empty custom field is true', () => {
  assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'customfield_1', operator: 'notEquals', value: 'x' }] }), trigger: 'issueCreated', issue: issueWith({}) }), true);
});

// --- Request type detection --------------------------------------------------------------------

test('request type is found whatever the request type field id is', () => {
  assert.equal(findRequestTypeId({ customfield_10010: { requestType: { id: 55 } } }), '55');
  assert.equal(findRequestTypeId({ customfield_10234: { requestType: { id: '7' } }, customfield_10010: 'ignored' }), '7');
});

test('a non-request-type object in customfield_10010 does not become "[object Object]"', () => {
  assert.equal(toIssueModel({ key: 'A-1', fields: { customfield_10010: { value: 'x' } } }).requestTypeId, '');
});

// --- Decisions ---------------------------------------------------------------------------------

test('shift end "keep" policy never changes the assignee', () => {
  assert.equal(decideForRule({ rule: rule({ trigger: 'shiftEnd', shiftEndPolicy: 'keep' }), issue: { assigneeAccountId: 'a' }, eligibleAccountIds: ['b'] }).action, 'keep');
});

test('shift end "unassign" policy unassigns only assigned tickets', () => {
  const r = rule({ trigger: 'shiftEnd', shiftEndPolicy: 'unassign' });
  assert.equal(decideForRule({ rule: r, issue: { assigneeAccountId: 'a' }, eligibleAccountIds: ['b'] }).action, 'unassign');
  assert.equal(decideForRule({ rule: r, issue: { assigneeAccountId: null }, eligibleAccountIds: ['b'] }).action, 'none');
});

test('no-agent unassign policy only applies when the ticket has an owner', () => {
  const r = rule({ noAgentPolicy: 'unassign' });
  assert.equal(decideForRule({ rule: r, issue: { assigneeAccountId: 'a' }, eligibleAccountIds: [] }).action, 'unassign');
  assert.equal(decideForRule({ rule: r, issue: { assigneeAccountId: null }, eligibleAccountIds: [] }).action, 'none');
});

test('forced reassignment that lands on the current owner is a no-op', () => {
  const result = decideForRule({ rule: rule({ forceReassign: true, assignmentStrategy: 'fixedOrder', fixedOrder: ['a'] }), issue: { assigneeAccountId: 'a' }, eligibleAccountIds: ['a', 'b'] });
  assert.deepEqual(result, { action: 'keep', assigneeAccountId: 'a', reason: 'ALREADY_ASSIGNED' });
});

test('least loaded spreads a batch when loads are updated between picks', () => {
  const loads = { a: 0, b: 0 };
  const picks = [];
  for (let i = 0; i < 4; i += 1) {
    const result = decideForRule({ rule: rule({ assignmentStrategy: 'leastLoaded' }), issue: { assigneeAccountId: null }, eligibleAccountIds: ['a', 'b'], loads });
    picks.push(result.assigneeAccountId);
    loads[result.assigneeAccountId] += 1;
  }
  assert.deepEqual(picks, ['a', 'b', 'a', 'b']);
});

// --- Shift boundary baseline -------------------------------------------------------------------

const now = new Date('2026-10-01T09:00:00Z');

test('first run only records a baseline', () => {
  assert.deepEqual(diffShiftState({ previous: undefined, current: ['a'], now }), { baseline: true, started: [], ended: [] });
});

test('a stale snapshot (routing was off) is treated as a baseline, not as mass shift changes', () => {
  const previous = { at: '2026-09-01T09:00:00Z', onShift: ['a', 'b'] };
  assert.equal(diffShiftState({ previous, current: ['c'], now }).baseline, true);
});

test('a recent snapshot reports who started and who ended', () => {
  const previous = { at: '2026-10-01T08:55:00Z', onShift: ['a', 'b'] };
  assert.deepEqual(diffShiftState({ previous, current: ['b', 'c'], now }), { baseline: false, started: ['c'], ended: ['a'] });
});

// --- Audit ordering ----------------------------------------------------------------------------

test('newer audit keys sort before older ones', () => {
  const older = auditKey(new Date('2026-09-01T00:00:00Z'), 'x');
  const newer = auditKey(new Date('2026-10-01T00:00:00Z'), 'x');
  assert.ok(newer < older);
  assert.ok(newer.startsWith(AUDIT_PREFIX));
});

test('new audit prefix does not overlap the legacy prefix', () => {
  assert.ok(!AUDIT_PREFIX.startsWith(LEGACY_AUDIT_PREFIX));
});

// --- Cover / absence validation ----------------------------------------------------------------

test('overrides are kept only for members with a valid window', () => {
  const result = normaliseOverrides([
    { id: 'ok', accountId: 'a', type: 'exclude', startAt: '2026-10-01T08:00:00Z', endAt: '2026-10-01T12:00:00Z' },
    { id: 'not-member', accountId: 'z', type: 'include', startAt: '2026-10-01T08:00:00Z', endAt: '2026-10-01T12:00:00Z' },
    { id: 'backwards', accountId: 'a', type: 'include', startAt: '2026-10-01T12:00:00Z', endAt: '2026-10-01T08:00:00Z' },
    { id: 'bad-date', accountId: 'a', type: 'include', startAt: 'soon', endAt: '2026-10-01T08:00:00Z' }
  ], ['a']);
  assert.deepEqual(result.map(o => o.id), ['ok']);
  assert.equal(result[0].type, 'exclude');
});

test('unknown override types default to include', () => {
  assert.equal(normaliseOverrides([{ accountId: 'a', type: 'weird', startAt: '2026-10-01T08:00:00Z', endAt: '2026-10-01T09:00:00Z' }], ['a'])[0].type, 'include');
});

test('shift group enable toggle is admin-only', () => {
  const start = backend.indexOf("resolver.define('setShiftGroupEnabled'");
  assert.ok(start > 0);
  assert.ok(backend.slice(start, start + 200).includes('await assertAdmin()'));
});
