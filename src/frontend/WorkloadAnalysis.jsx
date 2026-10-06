import React, { useState } from 'react';
import { BarChart, Box, Button, DynamicTable, Heading, Inline, Label, LineChart, Lozenge, SectionMessage, Select, Spinner, Stack, Text, Tooltip } from '@forge/react';
import { invoke } from '@forge/bridge';

const tile = { borderWidth: 'border.width', borderStyle: 'solid', borderColor: 'color.border', borderRadius: 'border.radius', padding: 'space.150', minWidth: '150px' };
const card = { borderWidth: 'border.width', borderStyle: 'solid', borderColor: 'color.border', borderRadius: 'border.radius', padding: 'space.200', backgroundColor: 'elevation.surface' };
const PERIODS = [{ label: 'Last 7 days', value: 7 }, { label: 'Last 30 days', value: 30 }, { label: 'Last 90 days', value: 90 }];
const ALL = { label: 'All shift groups', value: '' };
const SEVERITY = { high: 'error', medium: 'warning', low: 'information' };

function hours(h) {
  if (h == null) return '–';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.round(h * 10) / 10}h`;
  return `${Math.round((h / 24) * 10) / 10}d`;
}

function Stat({ title, value, detail }) {
  return <Box xcss={tile}><Stack space="space.050"><Text size="small">{title}</Text><Heading size="medium">{value}</Heading>{detail && <Text size="small">{detail}</Text>}</Stack></Box>;
}

function table(columns, rows) {
  return <Box xcss={{ overflowX: 'auto' }}><DynamicTable
    head={{ cells: columns.map(c => ({ key: c.key, content: c.label })) }}
    rows={rows.map((row, i) => ({ key: String(row.key ?? row.accountId ?? i), cells: columns.map(c => ({ key: c.key, content: c.render ? c.render(row) : <Text>{String(row[c.key] ?? '–')}</Text> })) }))}
  /></Box>;
}

function loadAppearance(cell, overall) {
  if (cell.load == null) return 'removed';
  if (!overall) return 'default';
  if (cell.load >= overall * 1.5) return 'removed';
  if (cell.load >= overall) return 'moved';
  return 'success';
}

// Admin-only workload analysis: demand, wait and resolution times, set against the rostered agents.
export default function WorkloadAnalysis({ projectOptions = [] }) {
  const [projects, setProjects] = useState([]);
  const [period, setPeriod] = useState(PERIODS[1]);
  const [group, setGroup] = useState(ALL);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function run() {
    setLoading(true); setError(null);
    try {
      setData(await invoke('getWorkloadAnalysis', { projectIds: (projects || []).map(p => p.value), days: period.value, groupId: group?.value || '' }));
    } catch (e) {
      setError(e?.message || 'Unable to run the analysis.');
    } finally { setLoading(false); }
  }

  const s = data?.summary;
  const overall = s?.ticketsPerAgentHour;
  const groupOptions = [ALL, ...(data?.groupOptions || [])];
  const demandVsAgents = (data?.byHourOfDay || []).flatMap(h => [
    { hour: h.hour, value: h.ticketsPerDay, series: 'Tickets created per day' },
    { hour: h.hour, value: h.agents, series: 'Agents on shift (average)' }
  ]);
  const trend = (data?.trend || []).flatMap(d => [{ date: d.date.slice(5), value: d.created, series: 'Created' }, { date: d.date.slice(5), value: d.resolved, series: 'Resolved' }]);
  const createdVsResolved = (data?.byHourOfDay || []).flatMap(h => [
    { hour: h.hour, value: h.ticketsPerDay, series: 'Created' },
    { hour: h.hour, value: h.resolvedPerDay, series: 'Resolved' }
  ]);
  const pickupByHour = (data?.byHourOfDay || []).map(h => ({ hour: h.hour, value: h.medianPickupHours || 0 }));

  const heatHead = { cells: [{ key: 'day', content: 'Day' }, ...Array.from({ length: 24 }, (_, h) => ({ key: `h${h}`, content: String(h).padStart(2, '0') }))] };
  const heatRows = (data?.heat || []).map(day => ({
    key: day.day,
    cells: [{ key: 'day', content: <Text as="strong">{day.label}</Text> }, ...day.hours.map((cell, h) => ({
      key: `h${h}`,
      content: !cell.tickets ? <Text>·</Text> : <Tooltip content={`${day.label} ${String(h).padStart(2, '0')}:00 · ${cell.tickets} ticket(s) a week · ${cell.agents} agent(s) on shift`}><Lozenge appearance={loadAppearance(cell, overall)}>{cell.load == null ? '!' : String(cell.load)}</Lozenge></Tooltip>
    }))]
  }));

  return <Stack space="space.200">
    <Box xcss={card}><Stack space="space.150">
    <Stack space="space.050"><Heading size="medium">Workload analysis</Heading>
    <Text color="color.text.subtle">See when work arrives, how long it waits and takes, and how that matches the agents on the rota. Staffing uses the current shift groups, so it reflects today's rota rather than past changes.</Text></Stack>
    <Inline space="space.200" alignBlock="end" shouldWrap>
      <Box xcss={{ minWidth: '320px' }}><Label labelFor="wl-projects">Projects</Label><Select id="wl-projects" isMulti options={projectOptions} value={projects} onChange={setProjects} placeholder="Choose service projects" /></Box>
      <Box xcss={{ minWidth: '170px' }}><Label labelFor="wl-period">Period</Label><Select id="wl-period" options={PERIODS} value={period} onChange={setPeriod} /></Box>
      <Box xcss={{ minWidth: '200px' }}><Label labelFor="wl-group">Compare against</Label><Select id="wl-group" options={groupOptions} value={group} onChange={setGroup} /></Box>
      <Button appearance="primary" isDisabled={!projects?.length} isLoading={loading} onClick={run}>Analyse</Button>
    </Inline>
    </Stack></Box>
    {error && <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>}
    {loading && !data && <Spinner size="large" />}

    {data && <Stack space="space.250">
      <Text size="small">{`${data.issueCount} ticket(s) analysed · ${new Date(data.from).toLocaleDateString()} – ${new Date(data.to).toLocaleDateString()} · times in Irish time`}</Text>
      {data.sampled && <SectionMessage appearance="warning"><Text>{`Only the newest ${data.maxIssues} tickets were analysed. Choose a shorter period or fewer projects for complete figures.`}</Text></SectionMessage>}

      <Heading size="small">Recommendations</Heading>
      {!data.recommendations.length && <SectionMessage appearance="success"><Text>No staffing mismatches stand out for this period.</Text></SectionMessage>}
      {data.recommendations.map((r, i) => <SectionMessage key={i} appearance={SEVERITY[r.severity]} title={r.title}><Text>{r.detail}</Text></SectionMessage>)}

      <Heading size="small">Summary</Heading>
      <Inline space="space.150" shouldWrap>
        <Stat title="Created" value={String(s.created)} detail={`${s.resolved} resolved · backlog ${s.backlogChange >= 0 ? '+' : ''}${s.backlogChange}`} />
        <Stat title="Time to pick up" value={hours(s.medianPickupHours)} detail={`median · 90% within ${hours(s.p90PickupHours)}`} />
        <Stat title="Time in progress" value={hours(s.medianInProgressHours)} detail="median, resolved tickets" />
        <Stat title="Time to resolution" value={hours(s.medianResolutionHours)} detail={`median · 90% within ${hours(s.p90ResolutionHours)}`} />
        <Stat title="SLA breaches" value={s.resolutionBreachPercent == null ? '–' : `${s.resolutionBreachPercent}%`} detail={`resolution · first response ${s.firstResponseBreachPercent == null ? '–' : `${s.firstResponseBreachPercent}%`}`} />
        <Stat title="Waiting now" value={String(s.notPickedUp)} detail={s.notPickedUp ? `oldest ${hours(s.oldestWaitingHours)}` : 'not yet picked up'} />
        <Stat title="Load" value={overall == null ? '–' : String(overall)} detail={`tickets per agent-hour · ${s.agentHours}h rostered`} />
      </Inline>

      <Box xcss={card}><LineChart showBorder={false} data={demandVsAgents} xAccessor="hour" yAccessor="value" colorAccessor="series" title="Demand vs staffing by hour of day" subtitle="Average tickets created per day in each hour, against the average agents on shift" height={300} /></Box>
      <Box xcss={card}><Stack space="space.100">
        <BarChart showBorder={false} data={createdVsResolved} xAccessor="hour" yAccessor="value" colorAccessor="series" title="Created vs resolved by hour of day" subtitle="Average tickets per day created and resolved in each hour (Irish time)" height={300} />
        {data.flow?.peakCreatedHour && <Text size="small" color="color.text.subtle">{`Most tickets arrive around ${data.flow.peakCreatedHour}${data.flow.peakResolvedHour ? ` and most are resolved around ${data.flow.peakResolvedHour}` : ''}.${data.flow.buildingHours.length ? ` The queue builds (more created than resolved) in ${data.flow.buildingHours.length} of 24 hours: ${data.flow.buildingHours.slice(0, 8).join(', ')}${data.flow.buildingHours.length > 8 ? '…' : ''}.` : ''}`}</Text>}
      </Stack></Box>
      <Box xcss={card}><BarChart showBorder={false} data={pickupByHour} xAccessor="hour" yAccessor="value" title="Time to pick up by hour created" subtitle="Median hours before a ticket created in that hour moved out of To Do" height={260} /></Box>
      {trend.length > 1 && <Box xcss={card}><LineChart showBorder={false} data={trend} xAccessor="date" yAccessor="value" colorAccessor="series" title="Created vs resolved per day" height={260} /></Box>}

      <Heading size="small">Load by hour of the week</Heading>
      <Text size="small">{`Tickets per agent on shift in each hour (overall ${overall ?? '–'}). Red: at least 1.5× the overall load, or tickets with nobody rostered (!) · amber: above average · green: below average.`}</Text>
      <Box xcss={{ overflowX: 'auto' }}><DynamicTable head={heatHead} rows={heatRows} /></Box>

      <Heading size="small">Agents</Heading>
      <Text size="small">Resolved tickets are counted against the current assignee. Use this to spot imbalance in the rota, not to rank people: ticket mix and non-ticket work aren't included.</Text>
      {table([
        { key: 'displayName', label: 'Agent', render: a => <Inline space="space.100" alignBlock="center"><Text>{a.displayName}</Text>{!a.onRota && <Lozenge appearance="moved">Not on rota</Lozenge>}</Inline> },
        { key: 'rosteredHours', label: 'Rostered', render: a => <Text>{a.rosteredHours == null ? '–' : `${a.rosteredHours}h`}</Text> },
        { key: 'resolved', label: 'Resolved' },
        { key: 'resolvedPer10Hours', label: 'Per 10 rostered h' },
        { key: 'medianResolutionHours', label: 'Median resolution', render: a => <Text>{hours(a.medianResolutionHours)}</Text> },
        { key: 'medianInProgressHours', label: 'Median in progress', render: a => <Text>{hours(a.medianInProgressHours)}</Text> },
        { key: 'open', label: 'Open now' }
      ], data.agents)}

      <Heading size="small">By priority</Heading>
      {table([
        { key: 'label', label: 'Priority' }, { key: 'created', label: 'Created' }, { key: 'resolved', label: 'Resolved' },
        { key: 'medianPickupHours', label: 'Median pickup', render: r => <Text>{hours(r.medianPickupHours)}</Text> },
        { key: 'medianResolutionHours', label: 'Median resolution', render: r => <Text>{hours(r.medianResolutionHours)}</Text> },
        { key: 'p90ResolutionHours', label: '90% within', render: r => <Text>{hours(r.p90ResolutionHours)}</Text> },
        { key: 'resolutionSlaBreachPercent', label: 'SLA breached', render: r => <Text>{r.resolutionSlaBreachPercent == null ? '–' : `${r.resolutionSlaBreachPercent}%`}</Text> }
      ], data.byPriority)}

      <Heading size="small">By request type</Heading>
      {table([
        { key: 'label', label: 'Request type' }, { key: 'created', label: 'Created' }, { key: 'resolved', label: 'Resolved' },
        { key: 'medianPickupHours', label: 'Median pickup', render: r => <Text>{hours(r.medianPickupHours)}</Text> },
        { key: 'medianResolutionHours', label: 'Median resolution', render: r => <Text>{hours(r.medianResolutionHours)}</Text> },
        { key: 'resolutionSlaBreachPercent', label: 'SLA breached', render: r => <Text>{r.resolutionSlaBreachPercent == null ? '–' : `${r.resolutionSlaBreachPercent}%`}</Text> }
      ], data.byType.slice(0, 25))}
    </Stack>}
  </Stack>;
}
