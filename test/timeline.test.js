import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dayEntry, hourBars, mergedBars } from '../src/frontend/timelineModel.js';

const roster = await readFile(new URL('../src/frontend/RosterView.jsx', import.meta.url), 'utf8');
const timeline = await readFile(new URL('../src/frontend/Timeline.jsx', import.meta.url), 'utf8');

const dates = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'].map(date => ({ date, label: date }));
const shift = (start, end, extra = {}) => ({ start, end, kind: 'shift', band: 'early', continued: false, overnight: false, ...extra });
const person = cells => ({ cells: Object.fromEntries(dates.map(d => [d.date, cells[d.date] || { shifts: [], absent: [] }])) });

test('consecutive days with the same hours merge into one bar', () => {
  const p = person({
    d1: { shifts: [shift('07:00', '16:00')], absent: [] }, d2: { shifts: [shift('07:00', '16:00')], absent: [] }, d3: { shifts: [shift('07:00', '16:00')], absent: [] },
    d5: { shifts: [shift('07:00', '16:00')], absent: [] }, d6: { shifts: [shift('09:00', '17:00', { band: 'day' })], absent: [] }
  });
  assert.deepEqual(mergedBars(p, dates).map(b => [b.from, b.span, b.entry.text, b.entry.kind]), [
    [0, 3, '07:00 – 16:00', 'early'], [4, 1, '07:00 – 16:00', 'early'], [5, 1, '09:00 – 17:00', 'day']
  ]);
});

test('cover and absence get their own bars and do not merge with normal shifts', () => {
  const p = person({
    d1: { shifts: [shift('07:00', '16:00')], absent: [] },
    d2: { shifts: [shift('07:00', '16:00', { kind: 'cover' })], absent: [] },
    d3: { shifts: [], absent: [{ start: '07:00', end: '16:00' }] }
  });
  assert.deepEqual(mergedBars(p, dates).map(b => b.entry.kind), ['early', 'cover', 'absent']);
});

test('a shift carried over from the night before is not drawn again in the week view', () => {
  assert.equal(dayEntry({ shifts: [shift('22:45', '07:45', { continued: true })], absent: [] }), null);
  assert.equal(dayEntry({ shifts: [shift('22:45', '07:45', { overnight: true, band: 'night' })], absent: [] }).text, '22:45 – 07:45 +1');
});

test('day view bars sit at their exact hours, overnight shifts run to midnight', () => {
  const p = person({ d1: { shifts: [shift('00:00', '07:45', { continued: true }), shift('22:45', '07:45', { overnight: true })], absent: [] } });
  assert.deepEqual(hourBars(p, 'd1').map(b => [b.start, b.end, b.text]), [[0, 465, 'until 07:45'], [1365, 1440, '22:45 – 07:45']]);
});

test('Timeline is a tab alongside Rota and Coverage, with agent and team views', () => {
  assert.ok(roster.includes('<Tab>Rota</Tab><Tab>Timeline</Tab><Tab>Coverage</Tab>'));
  for (const text of ['Agent view', 'Team view', 'Scheduled shifts', 'Average agent coverage']) assert.ok(timeline.includes(text), `missing ${text}`);
});
