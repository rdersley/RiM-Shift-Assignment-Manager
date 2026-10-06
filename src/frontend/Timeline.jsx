import React, { useState } from 'react';
import { Box, Button, ButtonGroup, Heading, Inline, Stack, Text, Tooltip } from '@forge/react';
import { hourBars, mergedBars } from './timelineModel.js';

// Gantt-style schedule: one row per person, bars across the days they work. In the week and 4-week
// views, consecutive days with the same hours merge into one bar; in the day view bars sit at their
// exact hours. Built from Box widths, as UI Kit has no timeline component.

const NAME_WIDTH = '220px';
const BAR = {
  early: { bg: 'color.background.accent.blue.subtler', label: 'Early' },
  day: { bg: 'color.background.accent.green.subtler', label: 'Day' },
  late: { bg: 'color.background.accent.orange.subtler', label: 'Late' },
  night: { bg: 'color.background.accent.purple.subtler', label: 'Night' },
  cover: { bg: 'color.background.accent.magenta.subtler', label: 'Cover' },
  absent: { bg: 'color.background.accent.red.subtler', label: 'Absent' }
};
const BAND_ORDER = ['early', 'day', 'late', 'night', 'off'];

const panel = { borderWidth: 'border.width', borderStyle: 'solid', borderColor: 'color.border', borderRadius: 'border.radius', backgroundColor: 'elevation.surface' };
const tile = { ...panel, padding: 'space.200', flexGrow: '1', minWidth: '180px' };
const headerCell = { paddingBlock: 'space.100', paddingInline: 'space.050' };

const pct = n => `${Math.max(0, Math.min(100, n)).toFixed(4)}%`;

function Bar({ width, kind, name, text, tip }) {
  return <Box xcss={{ width, paddingInline: 'space.025', paddingBlock: 'space.025' }}>
    <Tooltip content={`${name} · ${tip || text}`}>
      <Box xcss={{ backgroundColor: BAR[kind]?.bg || BAR.day.bg, borderRadius: 'border.radius', paddingBlock: 'space.050', paddingInline: 'space.100', overflow: 'hidden' }}>
        <Inline space="space.075" alignBlock="center"><Text size="small" weight="bold" maxLines={1}>{name}</Text><Text size="small" maxLines={1}>{text}</Text></Inline>
      </Box>
    </Tooltip>
  </Box>;
}

// Positions bars (each { offset%, width% }) along a track by inserting spacer boxes.
function Track({ items }) {
  let cursor = 0;
  const parts = [];
  items.forEach((item, i) => {
    if (item.offset > cursor + 0.0001) parts.push(<Box key={`gap-${i}`} xcss={{ width: pct(item.offset - cursor) }} />);
    parts.push(<Box key={`bar-${i}`} xcss={{ width: pct(item.width) }}>{item.node}</Box>);
    cursor = item.offset + item.width;
  });
  return <Box xcss={{ flexGrow: '1', minWidth: '0' }}><Inline space="space.0" alignBlock="center">{parts}</Inline></Box>;
}

function Row({ label, sublabel, children, shaded }) {
  return <Box xcss={{ backgroundColor: shaded ? 'color.background.neutral.subtle' : 'elevation.surface' }}>
    <Inline space="space.0" alignBlock="center">
      <Box xcss={{ width: NAME_WIDTH, minWidth: NAME_WIDTH, paddingBlock: 'space.100', paddingInline: 'space.150' }}>
        <Stack space="space.0"><Text weight="medium" maxLines={1}>{label}</Text>{sublabel && <Text size="small" color="color.text.subtle" maxLines={1}>{sublabel}</Text>}</Stack>
      </Box>
      {children}
    </Inline>
  </Box>;
}

export default function Timeline({ data }) {
  const [mode, setMode] = useState('team');
  const dates = data.dates;
  const singleDay = data.days === 1;
  const people = data.people;

  const shiftCount = people.reduce((sum, p) => sum + dates.reduce((n, d) => n + (p.cells[d.date]?.shifts || []).filter(s => !s.continued).length, 0), 0);
  const scheduledPeople = people.filter(p => dates.some(d => (p.cells[d.date]?.shifts || []).length)).length;
  const averageOnShift = Math.round((data.coverage.stats.agentHours / (data.days * 24)) * 10) / 10;

  // Team view groups by shift group, then band; agent view is one alphabetical list.
  const groups = mode === 'team'
    ? [...new Set(people.map(p => p.groupName))].map(name => ({
      name,
      people: people.filter(p => p.groupName === name).sort((a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band) || a.sortMinute - b.sortMinute || a.displayName.localeCompare(b.displayName))
    }))
    : [{ name: null, people: [...people].sort((a, b) => a.displayName.localeCompare(b.displayName)) }];

  function trackFor(person) {
    if (singleDay) {
      return <Track items={hourBars(person, dates[0].date).map(b => ({ offset: (b.start / 1440) * 100, width: ((b.end - b.start) / 1440) * 100, node: <Bar width="100%" kind={b.kind} name={person.displayName} text={b.text} tip={b.tip} /> }))} />;
    }
    return <Track items={mergedBars(person, dates).map(b => ({
      offset: (b.from / dates.length) * 100,
      width: (b.span / dates.length) * 100,
      node: <Bar width="100%" kind={b.entry.kind} name={person.displayName} text={b.entry.text} tip={`${b.entry.text}${b.span > 1 ? ` · ${b.span} days` : ''}`} />
    }))} />;
  }

  const columns = singleDay
    ? Array.from({ length: 12 }, (_, i) => ({ key: `h${i}`, label: `${String(i * 2).padStart(2, '0')}:00`, today: false }))
    : dates.map(d => ({ key: d.date, label: dates.length > 7 ? d.label.replace(/^\w+ /, '') : d.label.toUpperCase(), today: d.date === data.today }));

  return <Stack space="space.200">
    <Inline space="space.150" shouldWrap>
      <Box xcss={tile}><Stack space="space.050"><Text weight="medium">Scheduled shifts</Text><Inline space="space.100" alignBlock="baseline"><Heading size="large">{String(shiftCount)}</Heading><Text size="small" color="color.text.subtle">in this period</Text></Inline></Stack></Box>
      <Box xcss={tile}><Stack space="space.050"><Text weight="medium">Agents scheduled</Text><Inline space="space.100" alignBlock="baseline"><Heading size="large">{String(scheduledPeople)}</Heading><Text size="small" color="color.text.subtle">{`of ${people.length} on the rota`}</Text></Inline></Stack></Box>
      <Box xcss={tile}><Stack space="space.050"><Text weight="medium">Average agent coverage</Text><Inline space="space.100" alignBlock="baseline"><Heading size="large">{String(averageOnShift)}</Heading><Text size="small" color="color.text.subtle">agents per hour</Text></Inline></Stack></Box>
    </Inline>

    <Inline spread="space-between" alignBlock="center" shouldWrap>
      <Inline space="space.100" alignBlock="center" shouldWrap>
        {['early', 'day', 'late', 'night', 'cover', 'absent'].map(k => <Inline key={k} space="space.050" alignBlock="center"><Box xcss={{ width: '12px', height: '12px', borderRadius: 'border.radius', backgroundColor: BAR[k].bg }} /><Text size="small">{BAR[k].label}</Text></Inline>)}
      </Inline>
      <ButtonGroup>
        <Button appearance={mode === 'agent' ? 'primary' : 'default'} onClick={() => setMode('agent')}>Agent view</Button>
        <Button appearance={mode === 'team' ? 'primary' : 'default'} onClick={() => setMode('team')}>Team view</Button>
      </ButtonGroup>
    </Inline>

    <Box xcss={{ ...panel, overflowX: 'auto' }}><Box xcss={{ minWidth: singleDay ? '900px' : dates.length > 7 ? '1400px' : '1000px' }}>
      <Inline space="space.0" alignBlock="stretch">
        <Box xcss={{ width: NAME_WIDTH, minWidth: NAME_WIDTH, paddingBlock: 'space.100', paddingInline: 'space.150' }}><Text size="small" weight="bold" color="color.text.subtle">{mode === 'team' ? 'TEAM / AGENT' : 'AGENT'}</Text></Box>
        <Box xcss={{ flexGrow: '1', minWidth: '0' }}><Inline space="space.0">
          {columns.map(c => <Box key={c.key} xcss={{ ...headerCell, width: pct(100 / columns.length), backgroundColor: c.today ? 'color.background.selected' : 'elevation.surface' }}>
            <Text size="small" weight={c.today ? 'bold' : 'medium'} color={c.today ? 'color.text.selected' : 'color.text.subtle'} align="center" maxLines={1}>{c.label}</Text>
          </Box>)}
        </Inline></Box>
      </Inline>
      {groups.map(group => <Stack key={group.name || 'all'} space="space.0">
        {group.name && <Box xcss={{ paddingBlock: 'space.100', paddingInline: 'space.150', backgroundColor: 'color.background.neutral' }}>
          <Text weight="bold">{`${group.name} · ${group.people.length} ${group.people.length === 1 ? 'agent' : 'agents'}`}</Text>
        </Box>}
        {group.people.map((person, i) => <Row key={person.key} label={person.displayName} sublabel={[person.role, person.usualShift ? `usually ${person.usualShift}` : 'no shifts'].filter(Boolean).join(' · ')} shaded={i % 2 === 1}>
          {trackFor(person)}
        </Row>)}
      </Stack>)}
    </Box></Box>
    <Text size="small" color="color.text.subtle">Bars join consecutive days with the same hours. Hover a bar for details. "+1" ends the next day.</Text>
  </Stack>;
}
