import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ui = await readFile(new URL('../src/frontend/admin.jsx', import.meta.url), 'utf8');

test('V1 navigation exposes all primary admin areas', () => {
  for (const label of ['Dashboard', 'Schedule', 'Cover & Exceptions', 'Assignment Rules', 'Simulator', 'Audit Log']) {
    assert.ok(ui.includes(label), `missing ${label}`);
  }
});

test('saved shift members render display names', () => {
  assert.match(ui, /displayName/);
  assert.match(ui, /group\.members/);
});

test('schedule exposes day, week and four-week views with coverage analysis', async () => {
  const roster = await readFile(new URL('../src/frontend/RosterView.jsx', import.meta.url), 'utf8');
  for (const label of ['Day', 'Week', '4 weeks', 'Rota', 'Coverage', 'Nobody on shift', 'Minimum met']) assert.ok(roster.includes(label), `missing ${label}`);
  assert.ok(ui.includes('<RosterView resolverName="getRoster" canEditMinimum'));
});

test('rule builder exposes all V1 triggers', () => {
  for (const trigger of ['issueCreated', 'unassigned', 'statusChanged', 'customerReply', 'priorityChanged', 'slaThreshold', 'untouched', 'shiftStart', 'shiftEnd']) assert.ok(ui.includes(trigger), `missing ${trigger}`);
});

test('rule builder exposes assignment strategies and safety policies', () => {
  for (const value of ['roundRobin', 'leastLoaded', 'fixedOrder', 'random', 'shiftEndPolicy', 'noAgentPolicy', 'forceReassign']) assert.ok(ui.includes(value), `missing ${value}`);
});

test('simulator separates simulation from execution', () => {
  assert.ok(ui.includes('Simulate only'));
  assert.ok(ui.includes('Execute result'));
});

test('SLA rules use a readable Jira-backed SLA selector', () => {
  assert.ok(ui.includes("Label labelFor=\"sla\">SLA"));
  assert.ok(ui.includes('slaOptions'));
  assert.ok(ui.includes('requestJira'));
});

test('final worksite-safe controls are visible', () => {
  assert.ok(ui.includes('Automatic routing is OFF by default'));
  assert.ok(ui.includes('Edit shift group'));
  assert.ok(ui.includes('Edit assignment rule'));
  assert.ok(ui.includes('Temporary cover & absence'));
});
