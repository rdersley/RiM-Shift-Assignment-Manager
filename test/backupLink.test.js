import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { backupPagePath } from '../src/frontend/backupLink.js';

const admin = await readFile(new URL('../src/frontend/admin.jsx', import.meta.url), 'utf8');

test('backup link points at the Get started page for this app and environment', () => {
  const localId = 'ari:cloud:ecosystem::extension/0cba307a-da2b-4908-abd9-8ff94815f3f0/50ea6897-a86b-4273-a1da-5ec2fed445cc/static/retailinmotion-shift-assignment-manager-admin';
  assert.equal(backupPagePath({ localId }), '/jira/settings/apps/get-started/0cba307a-da2b-4908-abd9-8ff94815f3f0/50ea6897-a86b-4273-a1da-5ec2fed445cc');
  assert.equal(backupPagePath({ localId, environmentId: '49ff0412-f340-44ed-867d-f616a5d81d73' }), '/jira/settings/apps/get-started/0cba307a-da2b-4908-abd9-8ff94815f3f0/49ff0412-f340-44ed-867d-f616a5d81d73');
});

test('no link when the context has no app id', () => {
  assert.equal(backupPagePath({}), null);
  assert.equal(backupPagePath({ localId: 'something-else' }), null);
});

test('admin header has the Backup & restore button', () => {
  assert.ok(admin.includes('Backup & restore</Button>'));
  assert.ok(admin.includes('router.navigate(backupPath)'));
  assert.ok(!/\bview\.getContext/.test(admin), 'the tab state named view shadows the bridge import');
});
