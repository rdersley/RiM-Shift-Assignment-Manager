import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Box, Button, ButtonGroup, Heading, Inline, Label, Lozenge, SectionMessage, Spinner, Stack, Text, Textfield } from '@forge/react';
import { invoke } from '@forge/bridge';

const MODE_LABEL = { off: 'OFF', shadow: 'SHADOW', on: 'ON' };
const MODE_APPEARANCE = { off: 'default', shadow: 'inprogress', on: 'success' };

function App() {
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState('off');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState(null);

  async function refresh() {
    setLoading(true);
    try {
      const settings = await invoke('getRoutingSettings');
      setMode(settings?.routingMode || 'off');
      setMessage(null);
    } catch (error) {
      setMessage({ type: 'error', text: error?.message || 'Unable to load routing settings.' });
    } finally { setLoading(false); }
  }

  useEffect(() => { refresh(); }, []);

  async function changeMode(next) {
    if (next === 'on' && confirm.trim().toUpperCase() !== 'ENABLE') {
      setMessage({ type: 'error', text: 'Type ENABLE before turning on automatic routing.' });
      return;
    }
    setLoading(true);
    try {
      const settings = await invoke('setRoutingMode', { mode: next, confirmation: confirm });
      setMode(settings?.routingMode || 'off');
      setConfirm('');
      setMessage({ type: 'success', text: { off: 'Automatic routing disabled.', shadow: 'Shadow mode on: background routing will be logged but Jira will not be changed.', on: 'Automatic routing enabled.' }[settings?.routingMode || 'off'] });
    } catch (error) {
      setMessage({ type: 'error', text: error?.message || 'Unable to update routing settings.' });
    } finally { setLoading(false); }
  }

  return <Stack space="space.300">
    <Stack space="space.050"><Heading size="large">Automatic Routing Safety</Heading><Text>Global safety control for Shift & Assignment Manager background assignment.</Text></Stack>
    {message && <SectionMessage appearance={message.type === 'error' ? 'error' : 'success'}><Text>{message.text}</Text></SectionMessage>}
    {loading ? <Spinner size="medium" /> : <Box xcss={{ padding: 'space.300', borderWidth: 'border.width', borderStyle: 'solid', borderColor: 'color.border', borderRadius: 'border.radius' }}><Stack space="space.200">
      <Inline spread="space-between" alignBlock="center"><Stack space="space.050"><Heading size="medium">Background routing</Heading><Text>Issue events, SLA checks, untouched-ticket checks and shift-boundary routing.</Text></Stack><Lozenge appearance={MODE_APPEARANCE[mode]}>{MODE_LABEL[mode]}</Lozenge></Inline>
      {mode === 'off' && <SectionMessage appearance="information"><Text>Safe mode is active. Rules and the simulator can be configured, but background events cannot reassign tickets.</Text></SectionMessage>}
      {mode === 'shadow' && <SectionMessage appearance="information"><Text>Shadow mode is active. Background routing runs against real tickets and every decision is written to the Audit Log as "Shadow", but Jira assignees are never changed. Use this to check your rules before going live.</Text></SectionMessage>}
      {mode === 'on' && <SectionMessage appearance="warning"><Text>Automatic routing is live. Enabled assignment rules can change Jira assignees without manual confirmation.</Text></SectionMessage>}
      <ButtonGroup>
        {mode !== 'off' && <Button appearance={mode === 'on' ? 'danger' : 'default'} onClick={() => changeMode('off')}>Disable automatic routing</Button>}
        {mode !== 'shadow' && <Button onClick={() => changeMode('shadow')}>{mode === 'on' ? 'Switch to shadow mode' : 'Start shadow mode'}</Button>}
      </ButtonGroup>
      {mode !== 'on' && <Stack space="space.100"><Label labelFor="enable-confirm">To go live, type ENABLE</Label><Textfield id="enable-confirm" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="ENABLE"/><Button appearance="primary" isDisabled={confirm.trim().toUpperCase() !== 'ENABLE'} onClick={() => changeMode('on')}>Enable automatic routing</Button></Stack>}
    </Stack></Box>}
  </Stack>;
}

ForgeReconciler.render(<App />);
