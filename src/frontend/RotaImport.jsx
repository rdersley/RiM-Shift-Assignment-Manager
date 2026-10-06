import React, { useMemo, useState } from 'react';
import { Box, Button, FilePicker, Heading, Inline, Label, Lozenge, SectionMessage, Select, Spinner, Stack, Text, TextArea, Textfield, UserPicker } from '@forge/react';
import { invoke } from '@forge/bridge';
import { scheduleSummary } from './scheduleText.js';

const card = { borderWidth: 'border.width', borderStyle: 'solid', borderColor: 'color.border', borderRadius: 'border.radius', padding: 'space.200' };
const NEW_GROUP = '__new__';
const SKIP = '__skip__';

// Upload or paste a monthly rota, check each person's weekly pattern and Jira account, then import it
// as per-person hours in a shift group.
export default function RotaImport({ groups = [], onImported }) {
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [offset, setOffset] = useState('-7');
  const [preview, setPreview] = useState(null);
  const [choices, setChoices] = useState({});
  const [target, setTarget] = useState({ label: 'New shift group…', value: NEW_GROUP });
  const [newName, setNewName] = useState('Support Team');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const targetOptions = useMemo(() => [{ label: 'New shift group…', value: NEW_GROUP }, ...groups.map(g => ({ label: `${g.name} (${g.timezone})`, value: g.id }))], [groups]);
  const selected = (preview?.people || []).map(person => ({ person, user: choices[person.column] })).filter(x => x.user && x.user.accountId !== SKIP);

  async function runPreview() {
    setBusy(true); setMessage(null); setPreview(null);
    try {
      const result = await invoke('previewRota', { fileName: file?.name, fileData: file?.data, text: file ? '' : text, offsetHours: Number(offset) });
      setPreview(result);
      setChoices(Object.fromEntries(result.people.map(p => [p.column, p.match ? { accountId: p.match.accountId, displayName: p.match.displayName } : null])));
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || 'Unable to read the rota.' });
    } finally { setBusy(false); }
  }

  function choose(column, option) {
    setChoices(prev => ({ ...prev, [column]: option ? { accountId: option.value, displayName: option.label.replace(/ \(\d+%\)$/, '') } : null }));
  }

  async function runImport() {
    setBusy(true); setMessage(null);
    try {
      const result = await invoke('importRota', {
        groupId: target.value === NEW_GROUP ? '' : target.value,
        newGroup: { name: newName, timezone: 'Europe/Dublin' },
        people: selected.map(({ person, user }) => ({ accountId: user.accountId, displayName: user.displayName, role: person.role, schedule: person.schedule }))
      });
      setMessage({ type: 'success', text: `Imported ${result.imported} people into "${result.group.name}". Check the group on the Dashboard before relying on it for routing.` });
      setPreview(null);
      await onImported?.();
    } catch (e) {
      setMessage({ type: 'error', text: e?.message || 'Unable to import the rota.' });
    } finally { setBusy(false); }
  }

  return <Stack space="space.200">
    <Heading size="medium">Import rota</Heading>
    <SectionMessage appearance="information"><Text>Upload the monthly rota spreadsheet (or paste its cells). The first column must list weekdays, with names on the row above the first day. Each person's most recent week becomes their weekly pattern; nothing is saved until you press Import.</Text></SectionMessage>
    {message && <SectionMessage appearance={message.type === 'error' ? 'error' : 'success'}><Text>{message.text}</Text></SectionMessage>}

    <Box xcss={card}><Stack space="space.150">
      <FilePicker label="Rota spreadsheet" description=".xlsx or .csv" onChange={files => { setFile(files?.[0] || null); setPreview(null); }} />
      {file && <Inline space="space.100" alignBlock="center"><Text>Selected: {file.name}</Text><Button appearance="subtle" onClick={() => setFile(null)}>Clear</Button></Inline>}
      {!file && <><Label labelFor="rota-paste">Or paste the rota cells from Excel</Label><TextArea id="rota-paste" value={text} onChange={e => setText(e.target.value)} placeholder="Copy the whole rota range in Excel, then paste here" /></>}
      <Label labelFor="rota-offset">Adjust times by (hours)</Label>
      <Textfield id="rota-offset" value={offset} onChange={e => setOffset(e.target.value)} />
      <Text>Manila to Irish time is -7 hours during Irish summer time and -8 hours after the clocks go back (last Sunday in October). Times are stored in Irish time.</Text>
      <Button appearance="primary" isLoading={busy && !preview} onClick={runPreview}>Preview</Button>
    </Stack></Box>

    {busy && !preview && <Spinner size="medium" />}
    {preview && <Stack space="space.150">
      <Heading size="small">Preview: {preview.people.length} people · times adjusted by {preview.offsetHours} h</Heading>
      {preview.skipped?.length > 0 && <Text>Skipped (no shift times): {preview.skipped.join(', ')}</Text>}
      {preview.people.map(person => {
        const choice = choices[person.column];
        const options = [
          ...person.candidates.map(c => ({ label: c.score === 1 ? c.displayName : `${c.displayName} (${Math.round(c.score * 100)}%)`, value: c.accountId })),
          { label: 'Don’t import this person', value: SKIP }
        ];
        const value = choice ? options.find(o => o.value === choice.accountId) || { label: choice.displayName, value: choice.accountId } : null;
        return <Box key={person.column} xcss={card}><Stack space="space.100">
          <Inline spread="space-between" alignBlock="center">
            <Text as="strong">{person.role ? `${person.role} · ` : ''}{person.name}</Text>
            {choice?.accountId === SKIP ? <Lozenge>Skipped</Lozenge> : choice ? <Lozenge appearance="success">Jira user selected</Lozenge> : <Lozenge appearance="moved">Choose Jira user</Lozenge>}
          </Inline>
          <Text>{scheduleSummary(person.schedule)}</Text>
          {person.warnings.map((w, i) => <Text key={i}>⚠ {w}</Text>)}
          <Inline space="space.200" alignBlock="end">
            <Stack grow="fill"><Label labelFor={`match-${person.column}`}>Jira user</Label><Select id={`match-${person.column}`} options={options} value={value} onChange={o => choose(person.column, o)} placeholder={person.candidates.length ? 'Choose a match' : 'No match found'} /></Stack>
            <Stack grow="fill"><UserPicker label="Or search Jira" name={`pick-${person.column}`} onChange={u => u && choose(person.column, { value: u.id || u.value, label: u.name || u.label || u.displayName || u.id })} /></Stack>
          </Inline>
        </Stack></Box>;
      })}

      <Box xcss={card}><Stack space="space.150">
        <Label labelFor="rota-target">Import into</Label>
        <Select id="rota-target" options={targetOptions} value={target} onChange={setTarget} />
        {target.value === NEW_GROUP && <><Label labelFor="rota-name">New group name</Label><Textfield id="rota-name" value={newName} onChange={e => setNewName(e.target.value)} /><Text>The new group uses the Europe/Dublin timezone.</Text></>}
        {target.value !== NEW_GROUP && groups.find(g => g.id === target.value)?.timezone !== 'Europe/Dublin' && <SectionMessage appearance="warning"><Text>This group isn't on Irish time ({groups.find(g => g.id === target.value)?.timezone}). The imported times are Irish times, so they'd be read in the wrong timezone. Import into a Europe/Dublin group instead.</Text></SectionMessage>}
        {target.value !== NEW_GROUP && <Text>People already in the group keep their place; imported people get their new hours. Other members aren't changed.</Text>}
        <Button appearance="primary" isDisabled={!selected.length} isLoading={busy} onClick={runImport}>{`Import ${selected.length} ${selected.length === 1 ? 'person' : 'people'}`}</Button>
      </Stack></Box>
    </Stack>}
  </Stack>;
}
