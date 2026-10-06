import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = await readFile(new URL('../manifest.yml', import.meta.url), 'utf8');
const admin = await readFile(new URL('../src/frontend/admin.jsx', import.meta.url), 'utf8');
const schedule = await readFile(new URL('../src/frontend/schedule.jsx', import.meta.url), 'utf8');
const scheduleResolver = await readFile(new URL('../src/schedule.js', import.meta.url), 'utf8');
const backend = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

test('normal Jira users get a project sidebar Shift Schedule view', () => {
  assert.match(manifest, /jira:projectPage:/);
  assert.match(manifest, /title: Shift Schedule/);
  assert.match(manifest, /handler: schedule\.handler/);
  assert.ok(schedule.includes('getPublicSchedule'));
});

test('read-only schedule resolver exposes no mutation operations', () => {
  assert.ok(scheduleResolver.includes("resolver.define('getPublicSchedule'"));
  for (const forbidden of ['saveShiftGroup', 'deleteShiftGroup', 'saveAssignmentRule', 'executeAssignment']) {
    assert.ok(!scheduleResolver.includes(forbidden), `read-only resolver contains ${forbidden}`);
  }
});

test('all configuration and manual mutation paths retain admin checks', () => {
  for (const resolverName of ['saveShiftGroup', 'deleteShiftGroup', 'saveAssignmentRule', 'toggleAssignmentRule', 'deleteAssignmentRule', 'simulateAssignment', 'executeAssignment', 'getAuditLog']) {
    const marker = `resolver.define('${resolverName}'`;
    const start = backend.indexOf(marker);
    assert.ok(start >= 0, `missing ${resolverName}`);
    const fragment = backend.slice(start, start + 450);
    assert.ok(fragment.includes('await assertAdmin()'), `${resolverName} does not enforce admin permission`);
  }
});

test('admin rule builder uses Jira-backed selects instead of ID text boxes', () => {
  assert.ok(admin.includes("requestJira"));
  for (const endpoint of ['/rest/api/3/project/search', '/rest/api/3/priority', '/rest/api/3/field', '/rest/api/3/issuetype/project', '/statuses', '/rest/servicedeskapi/servicedesk']) {
    assert.ok(admin.includes(endpoint), `missing metadata source ${endpoint}`);
  }
  for (const label of ['Projects', 'Issue type', 'Request type', 'Status', 'Priority', 'Custom field', 'SLA']) {
    assert.ok(admin.includes(label), `missing picker ${label}`);
  }
  for (const oldLabel of ['Project IDs (optional, comma separated)', 'Issue type ID', 'Request type ID', 'Status ID', 'Priority ID', 'Custom field ID / key']) {
    assert.ok(!admin.includes(oldLabel), `raw ID field still visible: ${oldLabel}`);
  }
});

test('JSM request type scope is declared', () => {
  assert.match(manifest, /read:servicedesk-request/);
});
