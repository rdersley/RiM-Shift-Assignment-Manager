import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = await readFile(new URL('../manifest.yml', import.meta.url), 'utf8');

test('manifest keeps the Jira admin page', () => {
  assert.match(manifest, /jira:adminPage:/);
  assert.match(manifest, /title: Shift & Assignment Manager/);
});

test('manifest subscribes to the required Jira routing events', () => {
  for (const event of ['avi:jira:created:issue', 'avi:jira:updated:issue', 'avi:jira:assigned:issue', 'avi:jira:commented:issue']) {
    assert.ok(manifest.includes(event), `missing ${event}`);
  }
});

test('Jira event trigger ignores self-generated events', () => {
  assert.match(manifest, /ignoreSelf:\s*true/);
});

test('scheduled routing runs every five minutes', () => {
  assert.match(manifest, /scheduledTrigger:/);
  assert.match(manifest, /interval:\s*fiveMinute/);
});

test('background handlers are routed through the QA safety gate', () => {
  assert.match(manifest, /handler:\s*background\.jiraEventHandler/);
  assert.match(manifest, /handler:\s*background\.scheduledHandler/);
});

test('scheduled handler has an extended but bounded timeout', () => {
  assert.match(manifest, /timeoutSeconds:\s*300/);
});

test('required Jira and storage scopes remain present', () => {
  for (const scope of ['storage:app', 'read:user:jira', 'read:jira-work', 'write:jira-work']) {
    assert.ok(manifest.includes(`- ${scope}`), `missing ${scope}`);
  }
});
