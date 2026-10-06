import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = await readFile(new URL('../manifest.yml', import.meta.url), 'utf8');
const routing = await readFile(new URL('../src/routingSettings.js', import.meta.url), 'utf8');
const routingUi = await readFile(new URL('../src/frontend/routingSettings.jsx', import.meta.url), 'utf8');
const background = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
const admin = await readFile(new URL('../src/frontend/admin.jsx', import.meta.url), 'utf8');

test('routing safety configure page is admin-only and defaults off', () => {
  assert.match(routing, /getRoutingSettings/);
  assert.match(routing, /setRoutingMode/);
  assert.match(routing, /await assertAdmin\(\)/);
  assert.match(routing, /resolveRoutingMode\(stored, legacy\)/);
  assert.match(manifest, /useAsConfig: true/);
  assert.match(manifest, /handler: routingSettings\.handler/);
});

test('enabling automatic routing requires an explicit confirmation phrase', () => {
  assert.match(routingUi, /type ENABLE/i);
  assert.match(routingUi, /toUpperCase\(\) !== 'ENABLE'/);
  assert.match(routingUi, /isDisabled=\{confirm\.trim\(\)\.toUpperCase\(\) !== 'ENABLE'\}/);
  assert.match(routingUi, /Disable automatic routing/);
});

test('background handlers consult persisted routing safety before execution', () => {
  assert.match(background, /getRoutingMode/);
  assert.match(background, /failing closed/);
  assert.equal((background.match(/await currentRoutingMode\(\)/g) || []).length, 2);
});

test('shadow mode is offered without the ENABLE phrase but live mode still needs it', () => {
  assert.match(routingUi, /changeMode\('shadow'\)/);
  assert.match(routingUi, /next === 'on' && confirm\.trim\(\)\.toUpperCase\(\) !== 'ENABLE'/);
});

test('cover and absence controls are consolidated into the main admin UI', () => {
  for (const text of ['Cover & Exceptions', 'Temporary cover & absence', 'Cover shift — include user', 'Absence — exclude user', 'Add cover / exception']) {
    assert.ok(admin.includes(text), `missing ${text}`);
  }
  assert.ok(admin.includes("invoke('saveShiftGroup'"));
});

test('existing shifts and rules have edit-in-place controls', () => {
  for (const text of ['Edit shift group', 'Update shift group', 'Edit assignment rule', 'Update assignment rule', 'Cancel edit']) {
    assert.ok(admin.includes(text), `missing ${text}`);
  }
  assert.match(admin, /id:editShift\?\.id/);
  assert.match(admin, /id:editRule\?\.id/);
});

test('manifest has one normal admin page, one Configure safety page and the backup page', () => {
  const adminPageEntries = manifest.split('jira:projectPage:')[0].match(/- key: retailinmotion-shift-[^\n]+/g) || [];
  assert.equal(adminPageEntries.length, 3);
  assert.ok(adminPageEntries.some((entry) => entry.endsWith('retailinmotion-shift-assignment-backup')));
  assert.match(manifest, /title: Shift & Assignment Manager/);
  assert.match(manifest, /title: Shift Manager Routing Safety/);
  assert.ok(!manifest.includes('Shift Cover & Exceptions'));
  assert.ok(!manifest.includes('overrides-resolver'));
});
