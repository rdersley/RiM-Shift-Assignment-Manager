import React, { useState } from 'react';
import { Box, Button, Heading, Inline, Label, Select, Stack, Text, Textfield } from '@forge/react';
import { WEEK, scheduleSummary } from './scheduleText.js';

const card = { borderWidth: 'border.width', borderStyle: 'solid', borderColor: 'color.border', borderRadius: 'border.radius', padding: 'space.150' };

function toDraft(schedule = []) {
  const draft = {};
  for (const entry of schedule) if (!draft[entry.day]) draft[entry.day] = { start: entry.start, end: entry.end };
  return draft;
}

// Per-person hours inside a shift group. `value` is { accountId: [{ day, start, end }] };
// members without an entry use the group's hours.
export default function PersonalHours({ members = [], value = {}, onChange }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({});
  const [adding, setAdding] = useState(null);
  // The member being edited is shown even before they have any hours saved.
  const shown = members.filter(m => value[m.accountId]?.length || m.accountId === editing);
  const withoutHours = members.filter(m => !value[m.accountId]?.length);

  function begin(accountId) { setEditing(accountId); setDraft(toDraft(value[accountId])); setAdding(null); }
  function setTime(day, field, text) { setDraft(prev => ({ ...prev, [day]: { start: '', end: '', ...prev[day], [field]: text } })); }
  function save() {
    const schedule = WEEK.filter(d => draft[d.value]?.start && draft[d.value]?.end).map(d => ({ day: d.value, start: draft[d.value].start.trim(), end: draft[d.value].end.trim() }));
    const next = { ...value };
    if (schedule.length) next[editing] = schedule; else delete next[editing];
    onChange(next);
    setEditing(null);
  }
  function remove(accountId) { const next = { ...value }; delete next[accountId]; onChange(next); }

  return <Stack space="space.100">
    <Heading size="small">Personal hours</Heading>
    <Text>Members listed here work their own days and hours instead of the group's. Leave a day blank for a day off.</Text>
    {!shown.length && <Text>Everyone uses the group hours.</Text>}
    {shown.map(member => <Box key={member.accountId} xcss={card}>
      {editing === member.accountId
        ? <Stack space="space.100">
          <Text as="strong">{member.displayName}</Text>
          {WEEK.map(day => <Inline key={day.value} space="space.200" alignBlock="end">
            <Box xcss={{ width: 'size.1000' }}><Text>{day.label}</Text></Box>
            <Stack grow="fill"><Label labelFor={`ps-${day.value}`}>Start</Label><Textfield id={`ps-${day.value}`} placeholder="off" value={draft[day.value]?.start || ''} onChange={e => setTime(day.value, 'start', e.target.value)} /></Stack>
            <Stack grow="fill"><Label labelFor={`pe-${day.value}`}>End</Label><Textfield id={`pe-${day.value}`} placeholder="off" value={draft[day.value]?.end || ''} onChange={e => setTime(day.value, 'end', e.target.value)} /></Stack>
          </Inline>)}
          <Inline space="space.100"><Button appearance="primary" onClick={save}>Done</Button><Button appearance="subtle" onClick={() => setEditing(null)}>Cancel</Button></Inline>
        </Stack>
        : <Inline spread="space-between" alignBlock="center">
          <Stack space="space.050"><Text as="strong">{member.displayName}</Text><Text>{scheduleSummary(value[member.accountId])}</Text></Stack>
          <Inline space="space.100"><Button onClick={() => begin(member.accountId)}>Edit hours</Button><Button appearance="subtle" onClick={() => remove(member.accountId)}>Use group hours</Button></Inline>
        </Inline>}
    </Box>)}
    {withoutHours.length > 0 && editing == null && <Inline space="space.100" alignBlock="end">
      <Stack grow="fill"><Label labelFor="ph-add">Give a member their own hours</Label><Select id="ph-add" options={withoutHours.map(m => ({ label: m.displayName, value: m.accountId }))} value={adding} onChange={setAdding} /></Stack>
      <Button isDisabled={!adding} onClick={() => begin(adding.value)}>Set hours</Button>
    </Inline>}
  </Stack>;
}
