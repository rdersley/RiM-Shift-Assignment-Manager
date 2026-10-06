import React, { useEffect, useState } from 'react';
import { BarChart, Box, Button, ButtonGroup, DynamicTable, Heading, Inline, Label, Lozenge, SectionMessage, Select, Spinner, Stack, Tab, TabList, TabPanel, Tabs, Text, Tooltip } from '@forge/react';
import { invoke } from '@forge/bridge';
import Timeline from './Timeline.jsx';

const tile = { borderWidth: 'border.width', borderStyle: 'solid', borderColor: 'color.border', borderRadius: 'border.radius', padding: 'space.150', minWidth: '140px' };
const RANGES = [{ days: 1, label: 'Day' }, { days: 7, label: 'Week' }, { days: 28, label: '4 weeks' }];
const MIN_OPTIONS = Array.from({ length: 10 }, (_, i) => ({ label: String(i + 1), value: i + 1 }));
const ALL = { label: 'All shift groups', value: '' };
const LIST_LIMIT = 12;

function addDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function duration(minutes) {
  if (!minutes) return 'None';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

function Stat({ title, value, detail }) {
  return <Box xcss={tile}><Stack space="space.050"><Text size="small">{title}</Text><Heading size="medium">{value}</Heading>{detail && <Text size="small">{detail}</Text>}</Stack></Box>;
}

// Shift bands (by start time) share one colour across the rota, legend and headings.
const BANDS = [
  { key: 'early', label: 'Early', appearance: 'inprogress' },
  { key: 'day', label: 'Day', appearance: 'success' },
  { key: 'late', label: 'Late', appearance: 'moved' },
  { key: 'night', label: 'Night', appearance: 'new' },
  { key: 'off', label: 'No shifts', appearance: 'default' }
];
const bandOf = key => BANDS.find(b => b.key === key) || BANDS[4];
const card = { borderWidth: 'border.width', borderStyle: 'solid', borderColor: 'color.border', borderRadius: 'border.radius', padding: 'space.200', backgroundColor: 'elevation.surface' };

function ShiftCell({ cell, singleDay }) {
  // In a multi-day view a shift running from the night before is already shown on that day.
  const shifts = (cell?.shifts || []).filter(s => singleDay || !s.continued);
  if (!shifts.length && !cell?.absent?.length) return <Text color="color.text.subtlest">Off</Text>;
  return <Stack space="space.050">
    {shifts.map((s, i) => {
      const text = s.continued ? `until ${s.end}` : `${s.start}–${s.end}`;
      const tip = s.overnight ? `${s.start} to ${s.end} the next day` : s.continued ? `Started the day before, ends ${s.end}` : `${s.start} to ${s.end}`;
      return <Tooltip key={i} content={s.kind === 'cover' ? `Cover shift: ${tip}` : tip}>
        {s.kind === 'cover' ? <Lozenge appearance="new" isBold>{`Cover ${text}`}</Lozenge> : <Lozenge appearance={bandOf(s.band).appearance}>{text}</Lozenge>}
      </Tooltip>;
    })}
    {cell.absent.map((a, i) => <Tooltip key={`a${i}`} content={`Absent ${a.start}–${a.end}`}><Lozenge appearance="removed" isBold>Absent</Lozenge></Tooltip>)}
  </Stack>;
}

function heatAppearance(count, min) {
  if (count === 0) return 'removed';
  if (count < min) return 'moved';
  return 'success';
}

function RangeList({ title, appearance, items }) {
  if (!items.length) return null;
  return <SectionMessage appearance={appearance} title={title}><Stack space="space.050">
    {items.slice(0, LIST_LIMIT).map(item => <Text key={item.from}>{`${item.label} (${duration(item.minutes)})`}</Text>)}
    {items.length > LIST_LIMIT && <Text>{`…and ${items.length - LIST_LIMIT} more`}</Text>}
  </Stack></SectionMessage>;
}

// Rota grid and coverage analysis. `resolverName` is 'getRoster' on the admin page and
// 'getPublicSchedule' on the read-only project page; `canEditMinimum` shows the admin-only setting.
export default function RosterView({ resolverName, canEditMinimum = false, refreshKey = 0, onLoaded }) {
  const [days, setDays] = useState(7);
  const [startDate, setStartDate] = useState(null);
  const [groupId, setGroupId] = useState('');
  const [zone, setZone] = useState('Europe/Dublin');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load(next = {}) {
    const request = { days, startDate, groupId, displayTimeZone: zone, ...next };
    setLoading(true); setError(null);
    try {
      const result = await invoke(resolverName, request);
      setData(result);
      setDays(result.days); setStartDate(result.startDate); setGroupId(result.groupId || ''); setZone(result.displayTimeZone);
      onLoaded?.(result);
    } catch (e) {
      setError(e?.message || 'Unable to load the schedule.');
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [refreshKey]);

  async function changeMinimum(option) {
    try { await invoke('setMinCoverage', { minCoverage: option.value }); await load(); }
    catch (e) { setError(e?.message || 'Unable to update the minimum.'); }
  }

  const coverage = data?.coverage;
  const stats = coverage?.stats;
  const min = coverage?.minCoverage || 1;
  const zoneLabel = data?.zoneOptions?.find(z => z.value === data.displayTimeZone)?.label || data?.displayTimeZone;
  const groupOptions = [ALL, ...(data?.groupOptions || [])];
  const title = data ? (data.days === 1 ? data.dates[0]?.label : `${data.dates[0]?.label} – ${data.dates[data.dates.length - 1]?.label}`) : '';

  const singleDay = data?.days === 1;
  const rotaHead = data && {
    cells: [
      { key: 'person', content: 'Person', width: 22 },
      ...data.dates.map(d => ({ key: d.date, content: d.date === data.today ? `${d.label} (today)` : d.label })),
      { key: 'hours', content: 'Hours', width: 7 }
    ]
  };
  const multiGroup = (data?.groupOptions?.length || 0) > 1;
  const bandSections = BANDS.map(band => {
    const people = (data?.people || []).filter(p => (p.band || 'off') === band.key);
    if (!people.length) return null;
    const usual = [...new Set(people.map(p => p.usualShift).filter(Boolean))];
    const counts = data.dates.map(d => people.filter(p => (p.cells[d.date]?.shifts || []).some(s => singleDay || !s.continued)).length);
    const rows = people.map(p => ({
      key: p.key,
      cells: [
        { key: 'person', content: <Stack space="space.0"><Text weight="medium">{p.displayName}</Text>{(p.role || multiGroup) && <Text size="small" color="color.text.subtle">{[p.role, multiGroup ? p.groupName : ''].filter(Boolean).join(' · ')}</Text>}</Stack> },
        ...data.dates.map(d => ({ key: d.date, content: <ShiftCell cell={p.cells[d.date]} singleDay={singleDay} /> })),
        { key: 'hours', content: <Text>{`${p.hours}h`}</Text> }
      ]
    }));
    rows.push({
      key: `${band.key}-total`,
      cells: [
        { key: 'person', content: <Text weight="bold">On shift</Text> },
        ...data.dates.map((d, i) => ({ key: d.date, content: <Text weight="bold">{String(counts[i])}</Text> })),
        { key: 'hours', content: <Text weight="bold">{`${Math.round(people.reduce((sum, p) => sum + p.hours, 0))}h`}</Text> }
      ]
    });
    return { band, people, usual, rows };
  }).filter(Boolean);

  const heatHead = { cells: [{ key: 'day', content: 'Day' }, ...Array.from({ length: 24 }, (_, h) => ({ key: `h${h}`, content: String(h).padStart(2, '0') }))] };
  const heatRows = (coverage?.heat || []).map(day => ({
    key: day.date,
    cells: [
      { key: 'day', content: <Text as="strong">{day.label}</Text> },
      ...day.hours.map((h, i) => ({
        key: `h${i}`,
        content: h == null ? <Text>·</Text> : <Tooltip content={`${String(i).padStart(2, '0')}:00–${String(i + 1).padStart(2, '0')}:00 · ${h.min === h.max ? h.min : `${h.min}–${h.max}`} on shift`}><Lozenge appearance={heatAppearance(h.min, min)}>{String(h.min)}</Lozenge></Tooltip>
      }))
    ]
  }));

  return <Stack space="space.200">
    <Box xcss={card}><Stack space="space.150">
      <Inline spread="space-between" alignBlock="center" shouldWrap>
        <Stack space="space.050">
          <Heading size="medium">{title || 'Roster & coverage'}</Heading>
          {data && <Text size="small" color="color.text.subtle">{`${data.people.length} ${data.people.length === 1 ? 'person' : 'people'} · times in ${zoneLabel}`}</Text>}
        </Stack>
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <ButtonGroup>{RANGES.map(r => <Button key={r.days} appearance={days === r.days ? 'primary' : 'default'} onClick={() => load({ days: r.days, startDate: null })}>{r.label}</Button>)}</ButtonGroup>
          <ButtonGroup>
            <Button iconBefore="chevron-left" onClick={() => startDate && load({ startDate: addDays(startDate, -days) })}>Previous</Button>
            <Button onClick={() => load({ startDate: null })}>Today</Button>
            <Button iconAfter="chevron-right" onClick={() => startDate && load({ startDate: addDays(startDate, days) })}>Next</Button>
          </ButtonGroup>
        </Inline>
      </Inline>
      <Inline space="space.200" alignBlock="end" shouldWrap>
        <Box xcss={{ minWidth: '240px' }}><Label labelFor="roster-group">Shift group</Label><Select id="roster-group" options={groupOptions} value={groupOptions.find(o => o.value === groupId) || ALL} onChange={o => load({ groupId: o?.value || '' })} /></Box>
        <Box xcss={{ minWidth: '180px' }}><Label labelFor="roster-zone">Show times in</Label><Select id="roster-zone" options={data?.zoneOptions || []} value={(data?.zoneOptions || []).find(o => o.value === zone)} onChange={o => load({ displayTimeZone: o.value })} /></Box>
        {loading && data && <Spinner size="small" label="Loading" />}
      </Inline>
    </Stack></Box>
    {error && <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>}
    {loading && !data && <Spinner size="large" />}

    {data && <Tabs id="roster-tabs">
      <TabList><Tab>Rota</Tab><Tab>Timeline</Tab><Tab>Coverage</Tab></TabList>
      <TabPanel><Box xcss={{ paddingTop: 'space.200' }}>
        {!data.people.length && <SectionMessage appearance="information"><Text>No shift groups to show yet.</Text></SectionMessage>}
        {data.people.length > 0 && data.days > 7 && <SectionMessage appearance="information"><Text>Choose Day or Week to see each person's shifts. The Coverage tab covers all four weeks.</Text></SectionMessage>}
        {data.people.length > 0 && data.days <= 7 && <Stack space="space.200">
          <Inline space="space.100" alignBlock="center" shouldWrap>
            <Text size="small" color="color.text.subtle">Shift:</Text>
            {BANDS.slice(0, 4).map(b => <Lozenge key={b.key} appearance={b.appearance}>{b.label}</Lozenge>)}
            <Lozenge appearance="new" isBold>Cover</Lozenge>
            <Lozenge appearance="removed" isBold>Absent</Lozenge>
            <Text size="small" color="color.text.subtle">· Hover a shift for its exact times. Night shifts end the next morning.</Text>
          </Inline>
          {bandSections.map(section => <Box key={section.band.key} xcss={card}><Stack space="space.150">
            <Inline spread="space-between" alignBlock="center" shouldWrap>
              <Inline space="space.100" alignBlock="center"><Lozenge appearance={section.band.appearance} isBold>{section.band.label}</Lozenge><Heading size="small">{section.band.key === 'off' ? 'No shifts in this period' : `${section.band.label} shift`}</Heading></Inline>
              <Text size="small" color="color.text.subtle">{`${section.people.length} ${section.people.length === 1 ? 'person' : 'people'}${section.usual.length ? ` · usually ${section.usual.join(', ')}` : ''}`}</Text>
            </Inline>
            <Box xcss={{ overflowX: 'auto' }}><DynamicTable head={rotaHead} rows={section.rows} /></Box>
          </Stack></Box>)}
        </Stack>}
      </Box></TabPanel>
      <TabPanel><Box xcss={{ paddingTop: 'space.200' }}>
        {data.people.length ? <Timeline data={data} /> : <SectionMessage appearance="information"><Text>No shift groups to show yet.</Text></SectionMessage>}
      </Box></TabPanel>
      <TabPanel><Box xcss={{ paddingTop: 'space.200' }}><Stack space="space.200">
        <Inline space="space.150" shouldWrap>
          <Stat title="Lowest" value={`${stats.lowest} on shift`} detail={stats.lowestAt} />
          <Stat title="Peak" value={`${stats.peak} on shift`} detail={stats.peakAt} />
          <Stat title="Nobody on shift" value={duration(stats.uncoveredMinutes)} detail={`${coverage.gaps.length} period(s)`} />
          <Stat title={`Below ${min}`} value={duration(stats.belowMinimumMinutes)} detail={`${coverage.low.length} period(s)`} />
          <Stat title="Minimum met" value={`${stats.metMinimumPercent}%`} detail="of the time" />
          <Stat title="Agent hours" value={`${stats.agentHours}h`} detail="scheduled in range" />
        </Inline>
        {canEditMinimum
          ? <Inline space="space.100" alignBlock="center"><Label labelFor="roster-min">Minimum agents on shift</Label><Box xcss={{ width: '90px' }}><Select id="roster-min" options={MIN_OPTIONS} value={MIN_OPTIONS.find(o => o.value === min)} onChange={changeMinimum} /></Box><Text size="small" color="color.text.subtle">Used for the amber warnings below.</Text></Inline>
          : <Text size="small" color="color.text.subtle">{`Target: at least ${min} agent(s) on shift at all times.`}</Text>}
        <RangeList title="Nobody on shift" appearance="error" items={coverage.gaps} />
        <RangeList title={`Fewer than ${min} on shift`} appearance="warning" items={coverage.low} />
        {!coverage.gaps.length && !coverage.low.length && <SectionMessage appearance="success"><Text>{`At least ${min} agent(s) are on shift for the whole period.`}</Text></SectionMessage>}
        <Box xcss={card}><BarChart data={coverage.byHour} xAccessor="hour" yAccessor="average" title={data.days === 1 ? 'Agents on shift by hour' : 'Average agents on shift by hour of day'} subtitle={`Times in ${zoneLabel}`} height={280} showBorder={false} /></Box>
        <Heading size="small">Hour by hour</Heading>
        <Text size="small">Each cell is the fewest agents on shift during that hour. Red: nobody · amber: below minimum · green: minimum met.</Text>
        <Box xcss={{ overflowX: 'auto' }}><DynamicTable head={heatHead} rows={heatRows} /></Box>
      </Stack></Box></TabPanel>
    </Tabs>}
  </Stack>;
}
