import { localParts } from './shifts.js';

// Workload analysis: how much work arrives and when, how long it waits and takes, and how that
// lines up with the agents rostered on shift. Pure functions; the resolver supplies Jira data and
// the roster series.

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAMES = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const HOUR = 3_600_000;

export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
}

const round1 = n => (n == null ? null : Math.round(n * 10) / 10);
// Hourly rates read better as "under 0.1" than "0".
const rate = n => (n > 0 && n < 0.1 ? 'under 0.1' : String(round1(n)));
const toHours = ms => (ms == null ? null : round1(ms / HOUR));

export function hourOfWeek(at, timeZone) {
  const { day, minuteOfDay } = localParts(at, timeZone);
  return DAYS.indexOf(day) * 24 + Math.floor(minuteOfDay / 60);
}

const cellLabel = i => `${DAY_NAMES[DAYS[Math.floor(i / 24)]]} ${String(i % 24).padStart(2, '0')}:00`;


// Per-ticket timings from status history. `transitions` are [{ at, toCategory }] in time order,
// categories being Jira's 'new' | 'indeterminate' | 'done'.
export function ticketTimings(issue, now) {
  const created = issue.createdAt;
  const end = issue.resolvedAt ?? now;
  const moves = [...(issue.transitions || [])].filter(t => t.at >= created).sort((a, b) => a.at - b.at);
  const firstMove = moves.find(t => t.toCategory !== 'new');
  let inProgressMs = 0;
  let category = 'new';
  let since = created;
  for (const move of moves) {
    if (category === 'indeterminate') inProgressMs += Math.max(0, Math.min(move.at, end) - since);
    category = move.toCategory;
    since = move.at;
  }
  if (category === 'indeterminate') inProgressMs += Math.max(0, end - since);
  const pickupAt = firstMove?.at ?? issue.resolvedAt ?? null;
  return {
    pickupMs: pickupAt != null ? Math.max(0, pickupAt - created) : null,
    waitingMs: pickupAt == null ? Math.max(0, now - created) : null,
    inProgressMs: moves.some(m => m.toCategory === 'indeterminate') || category === 'indeterminate' ? inProgressMs : null,
    resolutionMs: issue.resolvedAt != null ? Math.max(0, issue.resolvedAt - created) : null
  };
}

function breakdown(issues, keyOf, labelOf) {
  const map = new Map();
  for (const issue of issues) {
    const key = keyOf(issue) || 'none';
    if (!map.has(key)) map.set(key, { key, label: labelOf(issue) || 'None', issues: [] });
    map.get(key).issues.push(issue);
  }
  return [...map.values()].map(({ key, label, issues: list }) => {
    const res = list.map(i => i.timings.resolutionMs).filter(v => v != null);
    const sla = list.filter(i => i.sla?.resolution);
    return {
      key, label, created: list.filter(i => i.inPeriod).length, resolved: res.length,
      medianResolutionHours: toHours(median(res)), p90ResolutionHours: toHours(percentile(res, 90)),
      medianPickupHours: toHours(median(list.map(i => i.timings.pickupMs))),
      resolutionSlaBreachPercent: sla.length ? round1((sla.filter(i => i.sla.resolution.breached).length / sla.length) * 100) : null
    };
  }).sort((a, b) => b.created - a.created || b.resolved - a.resolved);
}

/**
 * @param issues   normalised tickets: { key, createdAt, resolvedAt, priority, issueType, assigneeAccountId,
 *                 assigneeName, statusCategory, transitions, sla: { firstResponse?, resolution? } }
 * @param staffing { stepMinutes, series: [{ at, count }], rosteredHours: { accountId: hours } } for the period
 * @param period   { from, to } epoch ms
 */
export function analyseWorkload({ issues = [], staffing = { stepMinutes: 15, series: [], rosteredHours: {} }, period, timeZone = 'Europe/Dublin', now = Date.now() }) {
  const weeks = Math.max(1, (period.to - period.from) / (7 * 24 * HOUR));
  const enriched = issues.map(issue => ({ ...issue, inPeriod: issue.createdAt >= period.from && issue.createdAt < period.to, timings: ticketTimings(issue, now) }));
  const created = enriched.filter(i => i.inPeriod);
  const resolvedInPeriod = enriched.filter(i => i.resolvedAt != null && i.resolvedAt >= period.from && i.resolvedAt < period.to);

  // Demand and staffing by hour of week.
  const demand = Array(168).fill(0);
  for (const issue of created) demand[hourOfWeek(new Date(issue.createdAt), timeZone)] += 1;
  const agentSum = Array(168).fill(0);
  const agentSteps = Array(168).fill(0);
  for (const step of staffing.series || []) {
    const i = hourOfWeek(new Date(step.at), timeZone);
    agentSum[i] += step.count; agentSteps[i] += 1;
  }
  const agents = agentSum.map((s, i) => (agentSteps[i] ? s / agentSteps[i] : 0));
  const perWeek = demand.map(d => d / weeks);
  const totalAgentHours = agents.reduce((s, a) => s + a, 0) * weeks;
  const overallLoad = totalAgentHours ? created.length / totalAgentHours : null; // tickets per agent-hour
  const heat = DAYS.map((day, d) => ({
    day, label: DAY_NAMES[day],
    hours: Array.from({ length: 24 }, (_, h) => {
      const i = d * 24 + h;
      return { tickets: round1(perWeek[i]), agents: round1(agents[i]), load: agents[i] > 0 ? round1(perWeek[i] / agents[i]) : (perWeek[i] > 0 ? null : 0) };
    })
  }));

  // Hour of day profile (averaged over the period's days).
  const dayCount = Math.max(1, (period.to - period.from) / (24 * HOUR));
  const resolvedByHour = Array(24).fill(0);
  for (const issue of resolvedInPeriod) resolvedByHour[hourOfWeek(new Date(issue.resolvedAt), timeZone) % 24] += 1;
  const byHourOfDay = Array.from({ length: 24 }, (_, h) => {
    let tickets = 0; let agentAvg = 0;
    for (let d = 0; d < 7; d += 1) { tickets += demand[d * 24 + h]; agentAvg += agents[d * 24 + h]; }
    const pickups = created.filter(i => hourOfWeek(new Date(i.createdAt), timeZone) % 24 === h).map(i => i.timings.pickupMs);
    return {
      hour: `${String(h).padStart(2, '0')}:00`,
      ticketsPerDay: round1(tickets / dayCount), resolvedPerDay: round1(resolvedByHour[h] / dayCount),
      createdTotal: tickets, resolvedTotal: resolvedByHour[h],
      agents: round1(agentAvg / 7), medianPickupHours: toHours(median(pickups)), count: pickups.length
    };
  });
  // Busiest hours for arrivals and for resolutions, and how far apart they are.
  const peakHour = key => byHourOfDay.reduce((best, h) => (h[key] > best[key] ? h : best), byHourOfDay[0]);
  const flow = {
    peakCreatedHour: created.length ? peakHour('createdTotal').hour : null,
    peakResolvedHour: resolvedInPeriod.length ? peakHour('resolvedTotal').hour : null,
    // Hours where more arrive than get resolved on average, i.e. when the queue builds.
    buildingHours: byHourOfDay.filter(h => h.createdTotal > h.resolvedTotal).map(h => h.hour)
  };

  // Daily trend.
  const trend = new Map();
  const dayKey = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone });
  for (let t = period.from; t < period.to; t += 24 * HOUR) trend.set(dayKey(t), { date: dayKey(t), created: 0, resolved: 0 });
  for (const i of created) { const k = trend.get(dayKey(i.createdAt)); if (k) k.created += 1; }
  for (const i of resolvedInPeriod) { const k = trend.get(dayKey(i.resolvedAt)); if (k) k.resolved += 1; }

  // Agents: work resolved vs hours rostered.
  const agentMap = new Map();
  const ensure = (id, name) => { if (!agentMap.has(id)) agentMap.set(id, { accountId: id, displayName: name || id, resolved: 0, resolution: [], inProgress: [], open: 0 }); return agentMap.get(id); };
  for (const i of resolvedInPeriod) if (i.assigneeAccountId) { const a = ensure(i.assigneeAccountId, i.assigneeName); a.resolved += 1; a.resolution.push(i.timings.resolutionMs); if (i.timings.inProgressMs != null) a.inProgress.push(i.timings.inProgressMs); }
  for (const i of enriched) if (i.assigneeAccountId && i.statusCategory !== 'done') ensure(i.assigneeAccountId, i.assigneeName).open += 1;
  for (const id of Object.keys(staffing.rosteredHours || {})) ensure(id, staffing.names?.[id]);
  const agentRows = [...agentMap.values()].map(a => {
    const rostered = round1(staffing.rosteredHours?.[a.accountId] ?? null);
    return {
      accountId: a.accountId, displayName: staffing.names?.[a.accountId] || a.displayName, resolved: a.resolved, open: a.open,
      medianResolutionHours: toHours(median(a.resolution)), medianInProgressHours: toHours(median(a.inProgress)),
      rosteredHours: rostered, resolvedPer10Hours: rostered ? round1((a.resolved / rostered) * 10) : null, onRota: rostered != null
    };
  }).sort((a, b) => b.resolved - a.resolved || a.displayName.localeCompare(b.displayName));

  // Headline figures.
  const all = list => list.filter(v => v != null);
  const resolution = all(resolvedInPeriod.map(i => i.timings.resolutionMs));
  const pickup = all(created.map(i => i.timings.pickupMs));
  const inProgress = all(resolvedInPeriod.map(i => i.timings.inProgressMs));
  const slaRate = kind => { const list = enriched.filter(i => i.inPeriod && i.sla?.[kind]); return list.length ? round1((list.filter(i => i.sla[kind].breached).length / list.length) * 100) : null; };
  const openNow = enriched.filter(i => i.statusCategory !== 'done');
  const waitingNow = openNow.filter(i => i.timings.waitingMs != null);
  const summary = {
    created: created.length, resolved: resolvedInPeriod.length, backlogChange: created.length - resolvedInPeriod.length,
    medianPickupHours: toHours(median(pickup)), p90PickupHours: toHours(percentile(pickup, 90)),
    medianInProgressHours: toHours(median(inProgress)),
    medianResolutionHours: toHours(median(resolution)), p90ResolutionHours: toHours(percentile(resolution, 90)),
    firstResponseBreachPercent: slaRate('firstResponse'), resolutionBreachPercent: slaRate('resolution'),
    openInSample: openNow.length, notPickedUp: waitingNow.length, oldestWaitingHours: toHours(Math.max(0, ...waitingNow.map(i => i.timings.waitingMs))),
    agentHours: round1(totalAgentHours), ticketsPerAgentHour: overallLoad == null ? null : Math.round(overallLoad * 100) / 100
  };

  // Recommendations. Hours are pooled so one stray ticket can't flag a window: with low volume,
  // Mon–Fri and Sat–Sun are compared hour by hour; with enough tickets, each hour of the week.
  const recommendations = [];
  const occurrences = agentSteps.map(n => (n ? (n * (staffing.stepMinutes || 15)) / 60 : weeks));
  const byDayType = created.length < 168 * 4;
  const slotGroups = byDayType
    ? [{ label: 'Weekdays', days: [0, 1, 2, 3, 4] }, { label: 'Weekends', days: [5, 6] }]
    : DAYS.map((day, d) => ({ label: DAY_NAMES[day], days: [d] }));
  const slots = slotGroups.flatMap((g, gi) => Array.from({ length: 24 }, (_, hour) => {
    const cells = g.days.map(d => d * 24 + hour);
    const occ = cells.reduce((s, i) => s + occurrences[i], 0);
    const agentHours = cells.reduce((s, i) => s + agents[i] * occurrences[i], 0);
    return { group: gi, label: g.label, hour, tickets: cells.reduce((s, i) => s + demand[i], 0), occ, agentHours, agents: occ ? agentHours / occ : 0 };
  }));

  // Consecutive matching hours in the same group, joining 23:00 to 00:00 when pooling by day type.
  function windows(test) {
    const out = [];
    for (const g of slotGroups.keys()) {
      const hours = slots.filter(s => s.group === g);
      const hits = hours.map(test);
      if (hits.every(Boolean)) { out.push(hours); continue; }
      let startAt = 0;
      if (byDayType && hits[0] && hits[23]) startAt = hits.indexOf(false);
      let current = [];
      for (let k = 0; k < 24; k += 1) {
        const i = (startAt + k) % 24;
        if (hits[i]) current.push(hours[i]);
        else if (current.length) { out.push(current); current = []; }
      }
      if (current.length) out.push(current);
    }
    return out.map(list => {
      const tickets = list.reduce((s, x) => s + x.tickets, 0);
      const occ = list.reduce((s, x) => s + x.occ, 0);
      const agentHours = list.reduce((s, x) => s + x.agentHours, 0);
      const first = list[0].hour;
      const last = (list[list.length - 1].hour + 1) % 24;
      return { label: list.length === 24 ? `${list[0].label} all day` : `${list[0].label} ${String(first).padStart(2, '0')}:00–${String(last).padStart(2, '0')}:00`, hours: list.length, tickets, perHour: occ ? tickets / occ : 0, agents: occ ? agentHours / occ : 0, agentHours };
    });
  }

  function addTop(list, limit, make, moreText) {
    list.slice(0, limit).forEach(w => recommendations.push(make(w)));
    if (list.length > limit) recommendations.push({ severity: 'low', kind: 'more', title: `${list.length - limit} more ${moreText}`, detail: 'See the load table below for every hour.' });
  }

  addTop(
    windows(s => s.agents < 0.05 && s.tickets > 0).filter(w => w.tickets >= 3).sort((a, b) => b.tickets - a.tickets),
    5,
    w => ({ severity: 'high', kind: 'unstaffed', title: `Nobody rostered ${w.label}`, detail: `${Math.round(w.tickets)} ticket(s) arrived in this window during the period (about ${rate(w.perHour)} an hour) with no agent on shift. Add cover or extend an adjacent shift.` }),
    'uncovered window(s) with tickets'
  );
  if (overallLoad) {
    addTop(
      windows(s => s.agents >= 0.05 && s.tickets / Math.max(s.agentHours, 0.01) >= overallLoad * 1.5)
        .filter(w => w.tickets >= 6)
        .map(w => ({ ...w, excess: w.tickets - overallLoad * w.agentHours }))
        .sort((a, b) => b.excess - a.excess),
      5,
      w => ({ severity: 'medium', kind: 'understaffed', title: `Busy for the cover: ${w.label}`, detail: `About ${rate(w.perHour)} ticket(s) an hour with ${round1(w.agents)} agent(s) on shift: ${round1((w.tickets / w.agentHours) / overallLoad)}× the overall load. Moving a shift start into this window, or adding cover, would spread the work.` }),
      'busy window(s)'
    );
    addTop(
      windows(s => s.agents >= 2 && s.tickets / Math.max(s.agentHours, 0.01) <= overallLoad * 0.25)
        .filter(w => w.hours >= 3)
        .map(w => ({ ...w, spare: w.agentHours - w.tickets / overallLoad }))
        .sort((a, b) => b.spare - a.spare),
      3,
      w => ({ severity: 'low', kind: 'quiet', title: `Quiet with ${round1(w.agents)} agents: ${w.label}`, detail: `About ${rate(w.perHour)} ticket(s) an hour, under a quarter of the overall load. Some of this cover could move to a busier window.` }),
      'quiet window(s)'
    );
  }
  const overallPickup = median(pickup);
  if (overallPickup != null) {
    const slowHours = byHourOfDay.map((h, i) => ({ ...h, i, slow: h.count >= 5 && h.medianPickupHours != null && h.medianPickupHours * HOUR >= Math.max(overallPickup * 2, HOUR / 2) }));
    const groups = [];
    let startAt = slowHours[0].slow && slowHours[23].slow ? slowHours.findIndex(h => !h.slow) : 0;
    if (startAt < 0) startAt = 0;
    let current = [];
    for (let k = 0; k < 24; k += 1) {
      const h = slowHours[(startAt + k) % 24];
      if (h.slow) current.push(h); else if (current.length) { groups.push(current); current = []; }
    }
    if (current.length) groups.push(current);
    addTop(
      groups.map(list => ({ list, count: list.reduce((s, h) => s + h.count, 0) })).sort((a, b) => b.count - a.count),
      3,
      ({ list, count }) => ({ severity: 'medium', kind: 'slowPickup', title: `Slow pickup for tickets created ${String(list[0].i).padStart(2, '0')}:00–${String((list[list.length - 1].i + 1) % 24).padStart(2, '0')}:00`, detail: `${count} ticket(s) waited a median ${round1(median(list.map(h => h.medianPickupHours)))}h before work started, against ${toHours(overallPickup)}h overall. A shift starting earlier, or a handover at shift end, would shorten this.` }),
      'slow-pickup window(s)'
    );
  }
  if (summary.backlogChange > 0 && created.length >= 10 && summary.backlogChange / created.length >= 0.15) {
    recommendations.push({ severity: 'medium', kind: 'backlog', title: 'Backlog is growing', detail: `${summary.backlogChange} more ticket(s) were created than resolved in the period (${created.length} vs ${resolvedInPeriod.length}).` });
  }
  const notOnRota = agentRows.filter(a => !a.onRota && a.resolved >= 3);
  if (notOnRota.length) recommendations.push({ severity: 'low', kind: 'offRota', title: `${notOnRota.length} agent(s) resolving tickets aren't on any shift group`, detail: `${notOnRota.slice(0, 5).map(a => a.displayName).join(', ')}${notOnRota.length > 5 ? '…' : ''}. Their work isn't counted in the staffing figures, and routing can't assign to them.` });
  const order = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    summary, heat, byHourOfDay, flow, trend: [...trend.values()], agents: agentRows,
    byPriority: breakdown(enriched, i => i.priority, i => i.priority),
    byType: breakdown(enriched, i => i.requestType || i.issueType, i => i.requestType || i.issueType),
    recommendations, weeks: round1(weeks), peakCell: cellLabel(perWeek.indexOf(Math.max(...perWeek)))
  };
}
