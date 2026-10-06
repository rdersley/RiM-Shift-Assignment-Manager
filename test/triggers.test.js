import test from 'node:test';
import assert from 'node:assert/strict';
import { cooldownMinutesForRule, deriveEventTriggers, executionIsCoolingDown } from '../src/engine/triggers.js';

test('issue created maps to issueCreated', () => {
  assert.deepEqual(deriveEventTriggers({ eventType: 'avi:jira:created:issue' }), ['issueCreated']);
});

test('self generated events are ignored', () => {
  assert.deepEqual(deriveEventTriggers({ eventType: 'avi:jira:created:issue', selfGenerated: true }), []);
});

test('unassignment, priority and status changes are detected', () => {
  const event = {
    eventType: 'avi:jira:updated:issue',
    changelog: { items: [
      { field: 'assignee', to: null },
      { field: 'priority', to: '1' },
      { field: 'status', to: '3' }
    ] }
  };
  assert.deepEqual(deriveEventTriggers(event), ['unassigned', 'priorityChanged', 'statusChanged']);
});

test('agent comments do not masquerade as customer replies', () => {
  assert.deepEqual(deriveEventTriggers({ eventType: 'avi:jira:commented:issue', comment: { author: { accountType: 'atlassian' }, jsdPublic: true } }), []);
});

test('public customer comment maps to customerReply', () => {
  assert.deepEqual(deriveEventTriggers({ eventType: 'avi:jira:commented:issue', comment: { author: { accountType: 'customer' }, jsdPublic: true } }), ['customerReply']);
});

test('private customer comment does not trigger routing', () => {
  assert.deepEqual(deriveEventTriggers({ eventType: 'avi:jira:commented:issue', comment: { author: { accountType: 'customer' }, jsdPublic: false } }), []);
});

test('untouched rules get a conservative cooldown', () => {
  assert.equal(cooldownMinutesForRule({ trigger: 'untouched', untouchedMinutes: 60 }), 60);
  assert.equal(cooldownMinutesForRule({ trigger: 'untouched', untouchedMinutes: 5 }), 15);
});

test('cooldown blocks repeated execution inside the window', () => {
  assert.equal(executionIsCoolingDown({ lastExecutedAt: '2026-08-31T20:00:00Z', now: new Date('2026-08-31T20:01:00Z'), cooldownMinutes: 2 }), true);
  assert.equal(executionIsCoolingDown({ lastExecutedAt: '2026-08-31T20:00:00Z', now: new Date('2026-08-31T20:03:00Z'), cooldownMinutes: 2 }), false);
});
