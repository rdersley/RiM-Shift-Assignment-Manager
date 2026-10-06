import test from 'node:test';
import assert from 'node:assert/strict';
import { isMemberOnShift, getOnShiftMembers } from '../src/domain/shifts.js';

const group = {
  enabled: true,
  timezone: 'Europe/Dublin',
  memberAccountIds: ['a','b'],
  recurringSchedule: [{ day: 'mon', start: '08:00', end: '16:00' }]
};

test('member is eligible during recurring shift', () => {
  assert.equal(isMemberOnShift({ shiftGroup: group, accountId: 'a', at: new Date('2026-08-31T09:00:00Z') }), true);
});

test('shift start is inclusive and end is exclusive', () => {
  const utc = { ...group, timezone: 'UTC' };
  assert.equal(isMemberOnShift({ shiftGroup: utc, accountId: 'a', at: new Date('2026-08-31T08:00:00Z') }), true);
  assert.equal(isMemberOnShift({ shiftGroup: utc, accountId: 'a', at: new Date('2026-08-31T16:00:00Z') }), false);
});

test('disabled shift group never makes members eligible', () => {
  assert.equal(isMemberOnShift({ shiftGroup: { ...group, enabled: false }, accountId: 'a', at: new Date('2026-08-31T09:00:00Z') }), false);
});

test('non-member is never eligible', () => {
  assert.equal(isMemberOnShift({ shiftGroup: group, accountId: 'c', at: new Date('2026-08-31T09:00:00Z') }), false);
});

test('exclude override wins over recurring shift', () => {
  const overrides = [{ accountId: 'a', type: 'exclude', startAt: '2026-08-31T08:00:00Z', endAt: '2026-08-31T12:00:00Z' }];
  assert.equal(isMemberOnShift({ shiftGroup: group, accountId: 'a', at: new Date('2026-08-31T09:00:00Z'), overrides }), false);
});

test('include override can add a member outside their normal shift', () => {
  const overrides = [{ accountId: 'a', type: 'include', startAt: '2026-08-31T17:00:00Z', endAt: '2026-08-31T20:00:00Z' }];
  assert.equal(isMemberOnShift({ shiftGroup: group, accountId: 'a', at: new Date('2026-08-31T18:00:00Z'), overrides }), true);
});

test('exclude override wins when include and exclude overlap', () => {
  const overrides = [
    { accountId: 'a', type: 'include', startAt: '2026-08-31T08:00:00Z', endAt: '2026-08-31T20:00:00Z' },
    { accountId: 'a', type: 'exclude', startAt: '2026-08-31T08:00:00Z', endAt: '2026-08-31T20:00:00Z' }
  ];
  assert.equal(isMemberOnShift({ shiftGroup: group, accountId: 'a', at: new Date('2026-08-31T09:00:00Z'), overrides }), false);
});

test('returns on-shift members only', () => {
  assert.deepEqual(getOnShiftMembers({ shiftGroup: group, at: new Date('2026-08-31T09:00:00Z') }), ['a','b']);
});

test('overnight schedule carries into next day', () => {
  const overnight = { ...group, timezone: 'UTC', recurringSchedule: [{ day: 'mon', start: '23:00', end: '07:00' }] };
  assert.equal(isMemberOnShift({ shiftGroup: overnight, accountId: 'a', at: new Date('2026-09-01T02:00:00Z') }), true);
});

test('overnight shift stops exactly at configured end time', () => {
  const overnight = { ...group, timezone: 'UTC', recurringSchedule: [{ day: 'mon', start: '23:00', end: '07:00' }] };
  assert.equal(isMemberOnShift({ shiftGroup: overnight, accountId: 'a', at: new Date('2026-09-01T07:00:00Z') }), false);
});
