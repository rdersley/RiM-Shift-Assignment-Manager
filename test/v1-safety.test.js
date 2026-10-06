import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleMatches, matchingRules } from '../src/engine/rules.js';
import { selectAssignee, evaluateAssignment, shouldPreserveOwner } from '../src/engine/assignment.js';

const issue = {
  projectId: '10000', issueTypeId: '10001', requestTypeId: '7', statusId: '3', priorityId: '1',
  assigneeAccountId: 'agent-a', labels: ['vip', 'hardware'], componentIds: ['11'], fields: { customfield_12345: 'gold' }
};

function rule(overrides = {}) {
  return { id: 'r1', name: 'test', enabled: true, priority: 100, trigger: 'issueCreated', projectIds: [], conditions: [], assignmentStrategy: 'roundRobin', ...overrides };
}

test('disabled rule never matches', () => assert.equal(ruleMatches({ rule: rule({ enabled: false }), trigger: 'issueCreated', issue }), false));
test('wrong trigger never matches', () => assert.equal(ruleMatches({ rule: rule(), trigger: 'statusChanged', issue }), false));
test('project scope blocks unrelated project', () => assert.equal(ruleMatches({ rule: rule({ projectIds: ['99999'] }), trigger: 'issueCreated', issue }), false));
test('status condition matches', () => assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'statusId', operator: 'equals', value: '3' }] }), trigger: 'issueCreated', issue }), true));
test('priority condition blocks mismatch', () => assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'priorityId', operator: 'equals', value: '2' }] }), trigger: 'issueCreated', issue }), false));
test('label contains condition matches', () => assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'labels', operator: 'contains', value: 'vip' }] }), trigger: 'issueCreated', issue }), true));
test('custom field equality works', () => assert.equal(ruleMatches({ rule: rule({ conditions: [{ field: 'customfield_12345', operator: 'equals', value: 'gold' }] }), trigger: 'issueCreated', issue }), true));
test('matching rules always returns lowest priority number first', () => assert.deepEqual(matchingRules({ rules: [rule({ id: 'later', priority: 200 }), rule({ id: 'first', priority: 10 })], trigger: 'issueCreated', issue }).map(r => r.id), ['first', 'later']));
test('least loaded uses deterministic account id tie break', () => assert.equal(selectAssignee({ strategy: 'leastLoaded', eligibleAccountIds: ['b', 'a'], loads: { a: 2, b: 2 } }), 'a'));
test('fixed order ignores unavailable preferred agents', () => assert.equal(selectAssignee({ strategy: 'fixedOrder', eligibleAccountIds: ['b', 'c'], fixedOrder: ['a', 'c', 'b'] }), 'c'));
test('round robin wraps to first agent', () => assert.equal(selectAssignee({ strategy: 'roundRobin', eligibleAccountIds: ['a', 'b'], lastAssignedAccountId: 'b' }), 'a'));
test('round robin starts with first agent when rotation state is stale', () => assert.equal(selectAssignee({ strategy: 'roundRobin', eligibleAccountIds: ['a', 'b'], lastAssignedAccountId: 'old-agent' }), 'a'));
test('owner continuity is preserved only when eligible', () => { assert.equal(shouldPreserveOwner({ currentAssignee: 'a', eligibleAccountIds: ['a', 'b'] }), true); assert.equal(shouldPreserveOwner({ currentAssignee: 'c', eligibleAccountIds: ['a', 'b'] }), false); });
test('force reassignment overrides owner continuity', () => assert.equal(shouldPreserveOwner({ currentAssignee: 'a', eligibleAccountIds: ['a'], forceReassign: true }), false));
test('zero eligible agents is always non destructive', () => assert.deepEqual(evaluateAssignment({ rule: rule(), issue, eligibleAccountIds: [], loads: {} }), { action: 'none', reason: 'NO_ELIGIBLE_AGENT' }));
test('eligible current owner is kept by default', () => assert.deepEqual(evaluateAssignment({ rule: rule(), issue, eligibleAccountIds: ['agent-a', 'agent-b'], loads: {} }), { action: 'keep', assigneeAccountId: 'agent-a', reason: 'OWNER_CONTINUITY' }));
test('force reassignment selects a new assignment path', () => { const result = evaluateAssignment({ rule: rule({ forceReassign: true }), issue, eligibleAccountIds: ['agent-a', 'agent-b'], loads: {}, lastAssignedAccountId: 'agent-a' }); assert.equal(result.action, 'assign'); assert.equal(result.assigneeAccountId, 'agent-b'); });
