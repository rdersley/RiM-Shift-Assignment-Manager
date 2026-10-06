import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingRules } from '../src/engine/rules.js';
import { evaluateAssignment, selectAssignee } from '../src/engine/assignment.js';

const issue = { projectId: '10000', priorityId: '1', statusId: '10', assigneeAccountId: 'a', labels: ['vip'] };

test('matches and orders enabled rules', () => {
  const rules = [
    { id: 'r2', enabled: true, priority: 20, trigger: 'issueCreated', projectIds: ['10000'], conditions: [] },
    { id: 'r1', enabled: true, priority: 10, trigger: 'issueCreated', projectIds: ['10000'], conditions: [{ field: 'priorityId', operator: 'equals', value: '1' }] }
  ];
  assert.deepEqual(matchingRules({ rules, trigger: 'issueCreated', issue }).map(r => r.id), ['r1','r2']);
});

test('round robin advances to next eligible agent', () => {
  assert.equal(selectAssignee({ strategy: 'roundRobin', eligibleAccountIds: ['a','b','c'], lastAssignedAccountId: 'b' }), 'c');
});

test('least-loaded chooses the lightest eligible agent', () => {
  assert.equal(selectAssignee({ strategy: 'leastLoaded', eligibleAccountIds: ['a','b'], loads: { a: 8, b: 3 } }), 'b');
});

test('owner continuity avoids unnecessary churn', () => {
  const result = evaluateAssignment({ rule: { assignmentStrategy: 'roundRobin' }, issue, eligibleAccountIds: ['a','b'], loads: {}, lastAssignedAccountId: 'b' });
  assert.equal(result.action, 'keep');
  assert.equal(result.reason, 'OWNER_CONTINUITY');
});

test('no eligible agent is non-destructive', () => {
  const result = evaluateAssignment({ rule: { assignmentStrategy: 'roundRobin' }, issue, eligibleAccountIds: [], loads: {} });
  assert.deepEqual(result, { action: 'none', reason: 'NO_ELIGIBLE_AGENT' });
});
