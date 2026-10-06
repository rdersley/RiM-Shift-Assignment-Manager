import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normaliseEntries, normaliseGroup } from '../src/domain/shiftGroups.js';
import { isMemberOnShift } from '../src/domain/shifts.js';
import { auditKey, expiredAuditRanges, normaliseRetentionDays, DEFAULT_RETENTION_DAYS } from '../src/engine/audit.js';

const admin = await readFile(new URL('../src/frontend/admin.jsx', import.meta.url), 'utf8');
const backend = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');

// --- Per-day hours -----------------------------------------------------------------------------

const weekWithShortFriday = [
  ...['mon', 'tue', 'wed', 'thu'].map(day => ({ day, start: '09:00', end: '17:00' })),
  { day: 'fri', start: '09:00', end: '13:00' }
];

function group(recurringSchedule) {
  return normaliseGroup({ id: 'g', name: 'Desk', timezone: 'UTC', memberAccountIds: ['a'], recurringSchedule }, new Date('2026-10-01T00:00:00Z'));
}

test('per-day hours are kept as entered, not collapsed to the first day', () => {
  assert.deepEqual(group(weekWithShortFriday).recurringSchedule.find(s => s.day === 'fri'), { day: 'fri', start: '09:00', end: '13:00' });
});

test('a shorter Friday ends earlier than other days', () => {
  const g = group(weekWithShortFriday);
  // 2026-10-01 is a Thursday, 2026-10-02 a Friday.
  assert.equal(isMemberOnShift({ shiftGroup: g, accountId: 'a', at: new Date('2026-10-01T14:00:00Z') }), true);
  assert.equal(isMemberOnShift({ shiftGroup: g, accountId: 'a', at: new Date('2026-10-02T14:00:00Z') }), false);
  assert.equal(isMemberOnShift({ shiftGroup: g, accountId: 'a', at: new Date('2026-10-02T12:59:00Z') }), true);
});

test('one day can be an overnight shift while others are day shifts', () => {
  const g = group([{ day: 'thu', start: '09:00', end: '17:00' }, { day: 'fri', start: '22:00', end: '06:00' }]);
  assert.equal(isMemberOnShift({ shiftGroup: g, accountId: 'a', at: new Date('2026-10-03T03:00:00Z') }), true); // Sat 03:00, from Fri night
  assert.equal(isMemberOnShift({ shiftGroup: g, accountId: 'a', at: new Date('2026-10-02T03:00:00Z') }), false); // Fri 03:00, Thu was a day shift
});

test('a split shift (two windows on one day) is supported', () => {
  const g = group([{ day: 'mon', start: '08:00', end: '12:00' }, { day: 'mon', start: '14:00', end: '18:00' }]);
  assert.equal(g.recurringSchedule.length, 2);
  assert.equal(isMemberOnShift({ shiftGroup: g, accountId: 'a', at: new Date('2026-10-05T13:00:00Z') }), false);
  assert.equal(isMemberOnShift({ shiftGroup: g, accountId: 'a', at: new Date('2026-10-05T15:00:00Z') }), true);
});

test('entries are sorted Monday first and exact duplicates dropped', () => {
  const result = normaliseEntries([
    { day: 'sun', start: '10:00', end: '14:00' },
    { day: 'mon', start: '09:00', end: '17:00' },
    { day: 'mon', start: '09:00', end: '17:00' },
    { day: 'noday', start: '09:00', end: '17:00' }
  ]);
  assert.deepEqual(result.map(e => e.day), ['mon', 'sun']);
});

test('per-day validation names the day with the problem', () => {
  assert.throws(() => normaliseEntries([{ day: 'fri', start: '9am', end: '13:00' }]), /Friday: start time/);
  assert.throws(() => normaliseEntries([{ day: 'tue', start: '09:00', end: '09:00' }]), /Tuesday: start and end/);
});

test('the same-hours shape still works for existing callers', () => {
  const g = normaliseGroup({ name: 'Desk', timezone: 'UTC', memberAccountIds: ['a'], schedule: { days: ['wed', 'mon'], start: '08:00', end: '16:00' } });
  assert.deepEqual(g.recurringSchedule, [{ day: 'mon', start: '08:00', end: '16:00' }, { day: 'wed', start: '08:00', end: '16:00' }]);
});

test('admin form offers per-day hours and saves the per-day schedule', () => {
  assert.ok(admin.includes('Different hours per day'));
  assert.ok(admin.includes('recurringSchedule:buildSchedule()'));
});

test('cover and absence changes no longer re-save the whole shift group', () => {
  assert.ok(admin.includes("invoke('saveShiftOverride'"));
  assert.ok(admin.includes("invoke('deleteShiftOverride'"));
  for (const name of ['saveShiftOverride', 'deleteShiftOverride']) {
    const start = backend.indexOf(`resolver.define('${name}'`);
    assert.ok(start > 0, `missing ${name}`);
    assert.ok(backend.slice(start, start + 120).includes('await assertAdmin()'), `${name} is not admin-only`);
  }
});

test('saving a shift group keeps the stored cover entries', () => {
  assert.match(backend, /normaliseOverrides\(existing \? existing\.overrides : raw\.overrides/);
});

// --- Audit retention ---------------------------------------------------------------------------

const now = new Date('2026-10-02T12:00:00Z');
const cutoff = new Date(now.getTime() - 90 * 86_400_000);
const inRange = (key, { from, to }) => key >= from && key <= to;

test('an audit entry older than the cutoff falls in the expired range', () => {
  const [v2] = expiredAuditRanges(cutoff);
  assert.ok(inRange(auditKey(new Date('2026-06-01T00:00:00Z'), 'abc'), v2));
});

test('an audit entry newer than the cutoff is outside the expired range', () => {
  const [v2] = expiredAuditRanges(cutoff);
  assert.ok(!inRange(auditKey(new Date('2026-09-30T00:00:00Z'), 'abc'), v2));
  assert.ok(!inRange(auditKey(cutoff, 'abc'), v2));
});

test('legacy ascending audit keys are pruned by the same cutoff', () => {
  const [, legacy] = expiredAuditRanges(cutoff);
  assert.ok(inRange('assignment-audit:2026-06-01T00:00:00.000Z:x', legacy));
  assert.ok(!inRange('assignment-audit:2026-09-30T00:00:00.000Z:x', legacy));
  assert.ok(!inRange(auditKey(new Date('2026-06-01T00:00:00Z'), 'x'), legacy), 'legacy range must not touch new keys');
});

test('retention only accepts the offered values', () => {
  assert.equal(normaliseRetentionDays(30), 30);
  assert.equal(normaliseRetentionDays('365'), 365);
  assert.equal(normaliseRetentionDays(7), DEFAULT_RETENTION_DAYS);
  assert.equal(normaliseRetentionDays(undefined), DEFAULT_RETENTION_DAYS);
});

test('audit entries and cooldown markers are written with an expiry', () => {
  const auditFn = backend.slice(backend.indexOf('async function audit('), backend.indexOf('function markerTtlDays'));
  assert.match(auditFn, /setWithTtl\(key,/);
  assert.ok(!/kvs\.set\(\w*ExecutionKey/.test(backend), 'cooldown markers must use setWithTtl');
});

test('housekeeping runs on every scheduled tick before the routing-mode gate', () => {
  const handler = background.slice(background.indexOf('export async function scheduledHandler'));
  assert.ok(handler.indexOf('runHousekeeping()') > 0);
  assert.ok(handler.indexOf('runHousekeeping()') < handler.indexOf('currentRoutingMode()'));
});

test('retention setting is admin-only', () => {
  const start = backend.indexOf("resolver.define('setAuditRetention'");
  assert.ok(start > 0);
  assert.ok(backend.slice(start, start + 120).includes('await assertAdmin()'));
});
