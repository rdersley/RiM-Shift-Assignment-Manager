import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normaliseRequestedMode, resolveRoutingMode } from '../src/engine/routingMode.js';

const background = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
const settings = await readFile(new URL('../src/routingSettings.js', import.meta.url), 'utf8');
const core = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

test('automatic routing defaults to off when no setting exists', () => {
  assert.equal(resolveRoutingMode(undefined, undefined), 'off');
  assert.equal(resolveRoutingMode(null, false), 'off');
});

test('an install that was ON before 0.9 stays ON after upgrade', () => {
  assert.equal(resolveRoutingMode(undefined, true), 'on');
});

test('stored mode wins over the legacy switch', () => {
  assert.equal(resolveRoutingMode('shadow', true), 'shadow');
  assert.equal(resolveRoutingMode('off', true), 'off');
});

test('unknown stored or requested modes are treated as off', () => {
  assert.equal(resolveRoutingMode('live', false), 'off');
  assert.equal(normaliseRequestedMode('ON'), 'off');
  assert.equal(normaliseRequestedMode(undefined), 'off');
});

test('background routing fails closed if settings cannot be read', () => {
  assert.match(background, /failing closed/);
  assert.match(background, /return 'off'/);
});

test('both background entry points enforce the routing mode', () => {
  assert.equal((background.match(/await currentRoutingMode\(\)/g) || []).length, 2);
  assert.equal((background.match(/if \(mode === 'off'\)/g) || []).length, 2);
  assert.equal((background.match(/dryRun: mode !== 'on'/g) || []).length, 2);
});

test('core background handlers default to dry run when called without a mode', () => {
  assert.match(core, /export async function jiraEventHandler\(event, _context, \{ dryRun = true \} = \{\}\)/);
  assert.match(core, /export async function scheduledHandler\(_request, _context, \{ dryRun = true \} = \{\}\)/);
});

test('dry run never calls the Jira assignee endpoint', () => {
  const start = core.indexOf('async function executeDecision');
  const body = core.slice(start, core.indexOf('async function simulateInternal'));
  const put = body.indexOf('/assignee');
  assert.ok(put > 0);
  assert.ok(body.lastIndexOf('if (!dryRun) {', put) > 0, 'assignee PUT must sit inside if (!dryRun)');
});

test('routing setting writes require Jira admin permission and ENABLE for live mode', () => {
  assert.match(settings, /setRoutingMode/);
  assert.match(settings, /await assertAdmin\(\)/);
  assert.match(settings, /mode === 'on' && String\(payload\?\.confirmation \|\| ''\)\.trim\(\)\.toUpperCase\(\) !== 'ENABLE'/);
});
