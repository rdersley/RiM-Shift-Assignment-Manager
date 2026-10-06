import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseGroup, normaliseSchedule } from '../src/domain/shiftGroups.js';

const now = new Date('2026-08-31T18:00:00Z');

test('normaliseGroup trims values and removes duplicate members', () => {
  const group = normaliseGroup({
    id: 'g1',
    name: '  Service Desk  ',
    timezone: 'Europe/Dublin',
    memberAccountIds: [' a ', 'a', 'b', ''],
    schedule: { days: ['mon', 'mon', 'wed'], start: '09:00', end: '17:00' }
  }, now);
  assert.equal(group.name, 'Service Desk');
  assert.deepEqual(group.memberAccountIds, ['a', 'b']);
  assert.deepEqual(group.recurringSchedule, [
    { day: 'mon', start: '09:00', end: '17:00' },
    { day: 'wed', start: '09:00', end: '17:00' }
  ]);
});

test('normaliseGroup preserves createdAt when editing an existing group', () => {
  const group = normaliseGroup({
    id: 'g1', name: 'Desk', timezone: 'UTC', memberAccountIds: ['a'],
    createdAt: '2026-08-01T00:00:00.000Z',
    schedule: { days: ['mon'], start: '09:00', end: '17:00' }
  }, now);
  assert.equal(group.createdAt, '2026-08-01T00:00:00.000Z');
  assert.equal(group.updatedAt, now.toISOString());
});

test('normaliseGroup rejects missing name', () => {
  assert.throws(() => normaliseGroup({
    timezone: 'UTC', memberAccountIds: ['a'], schedule: { days: ['mon'], start: '09:00', end: '17:00' }
  }, now), /name is required/i);
});

test('normaliseGroup rejects no members', () => {
  assert.throws(() => normaliseGroup({
    name: 'Desk', timezone: 'UTC', memberAccountIds: [], schedule: { days: ['mon'], start: '09:00', end: '17:00' }
  }, now), /at least one Jira user/i);
});

test('normaliseGroup rejects no valid days', () => {
  assert.throws(() => normaliseGroup({
    name: 'Desk', timezone: 'UTC', memberAccountIds: ['a'], schedule: { days: ['noday'], start: '09:00', end: '17:00' }
  }, now), /working day/i);
});

test('normaliseGroup rejects invalid timezone', () => {
  assert.throws(() => normaliseGroup({
    name: 'Desk', timezone: 'Not/A_Timezone', memberAccountIds: ['a'], schedule: { days: ['mon'], start: '09:00', end: '17:00' }
  }, now), /valid IANA timezone/i);
});

test('normaliseSchedule rejects invalid clock values', () => {
  assert.throws(() => normaliseSchedule({ days: ['mon'], start: '25:00', end: '17:00' }), /Start time/);
  assert.throws(() => normaliseSchedule({ days: ['mon'], start: '09:00', end: '17:75' }), /End time/);
});
