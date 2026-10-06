import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAssignment, selectAssignee, shouldPreserveOwner } from '../src/engine/assignment.js';
import { matchingRules, ruleMatches } from '../src/engine/rules.js';
import { deriveEventTriggers, executionIsCoolingDown } from '../src/engine/triggers.js';

const issue = {
  projectId: '10000', issueTypeId: '10100', requestTypeId: '55', statusId: '3', priorityId: '1',
  assigneeAccountId: 'agent-a', labels: ['vip', 'hardware'], componentIds: ['200'],
  fields: { customfield_12345: 'RYR' }
};

function rule(overrides = {}) {
  return {
    id: 'rule-1', name: 'Safety rule', enabled: true, priority: 100, trigger: 'issueCreated',
    projectIds: ['10000'], conditions: [], shiftGroupIds: ['group-1'], assignmentStrategy: 'roundRobin',
    fixedOrder: [], forceReassign: false, ...overrides
  };
}

test('wrong project can never match an automatic rule', () => {
  assert.equal(ruleMatches({ rule: rule({ projectIds: ['99999'] }), trigger: 'issueCreated', issue }), false);
});

test('disabled rule can never match', () => {
  assert.equal(ruleMatches({ rule: rule({ enabled: false }), trigger: 'issueCreated', issue }), false);
});

test('wrong trigger can never match', () => {
  assert.equal(ruleMatches({ rule: rule(), trigger: 'customerReply', issue }), false);
});

test('request type conditions are enforced', () => {
  assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'requestTypeId', operator: 'equals', value: '55' }] }), trigger: 'issueCreated', issue }), true);
  assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'requestTypeId', operator: 'equals', value: '99' }] }), trigger: 'issueCreated', issue }), false);
});

test('label conditions are enforced', () => {
  assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'labels', operator: 'contains', value: 'hardware' }] }), trigger: 'issueCreated', issue }), true);
  assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'labels', operator: 'contains', value: 'finance' }] }), trigger: 'issueCreated', issue }), false);
});

test('custom Jira field conditions are enforced', () => {
  assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'customfield_12345', operator: 'equals', value: 'RYR' }] }), trigger: 'issueCreated', issue }), true);
  assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'customfield_12345', operator: 'equals', value: 'LDA' }] }), trigger: 'issueCreated', issue }), false);
});

test('highest-priority matching rule wins deterministically', () => {
  const rules = [rule({ id: 'late', priority: 200 }), rule({ id: 'first', priority: 10 })];
  assert.equal(matchingRules({ rules, trigger: 'issueCreated', issue })[0].id, 'first');
});

test('zero eligible agents is always non-destructive by default', () => {
  assert.deepEqual(evaluateAssignment({ rule: rule(), issue, eligibleAccountIds: [], loads: {}, lastAssignedAccountId: null }), { action: 'none', reason: 'NO_ELIGIBLE_AGENT' });
});

test('existing eligible owner is preserved unless force reassignment is explicit', () => {
  assert.equal(shouldPreserveOwner({ currentAssignee: 'agent-a', eligibleAccountIds: ['agent-a', 'agent-b'], forceReassign: false }), true);
  assert.equal(shouldPreserveOwner({ currentAssignee: 'agent-a', eligibleAccountIds: ['agent-a', 'agent-b'], forceReassign: true }), false);
});

test('least-loaded never selects an ineligible user even if their load is lower', () => {
  assert.equal(selectAssignee({ strategy: 'leastLoaded', eligibleAccountIds: ['agent-a', 'agent-b'], loads: { 'agent-a': 8, 'agent-b': 3, outsider: 0 } }), 'agent-b');
});

test('fixed order ignores unavailable preferred agents', () => {
  assert.equal(selectAssignee({ strategy: 'fixedOrder', eligibleAccountIds: ['agent-b', 'agent-c'], fixedOrder: ['agent-a', 'agent-c'] }), 'agent-c');
});

test('round robin recovers safely when previous assignee is no longer eligible', () => {
  assert.equal(selectAssignee({ strategy: 'roundRobin', eligibleAccountIds: ['agent-b', 'agent-c'], lastAssignedAccountId: 'agent-a' }), 'agent-b');
});

test('self-generated assignment events cannot recurse', () => {
  assert.deepEqual(deriveEventTriggers({ eventType: 'avi:jira:updated:issue', selfGenerated: true, changelog: { items: [{ field: 'assignee', to: null }] } }), []);
});

test('agent comments cannot be treated as customer replies', () => {
  assert.deepEqual(deriveEventTriggers({ eventType: 'avi:jira:commented:issue', comment: { author: { accountType: 'atlassian' }, jsdPublic: true } }), []);
});

test('duplicate event execution is blocked during cooldown', () => {
  assert.equal(executionIsCoolingDown({ lastExecutedAt: '2026-08-31T20:00:00Z', now: new Date('2026-08-31T20:01:59Z'), cooldownMinutes: 2 }), true);
  assert.equal(executionIsCoolingDown({ lastExecutedAt: '2026-08-31T20:00:00Z', now: new Date('2026-08-31T20:02:00Z'), cooldownMinutes: 2 }), false);
});
