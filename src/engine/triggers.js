function changelogItems(event = {}) {
  if (Array.isArray(event.changelog)) return event.changelog;
  if (Array.isArray(event.changelog?.items)) return event.changelog.items;
  return [];
}

function fieldKey(item = {}) {
  return String(item.fieldId || item.field || '').trim().toLowerCase();
}

export function deriveEventTriggers(event = {}) {
  if (event.selfGenerated) return [];

  if (event.eventType === 'avi:jira:created:issue') {
    return ['issueCreated'];
  }

  if (event.eventType === 'avi:jira:commented:issue') {
    const accountType = String(event.comment?.author?.accountType || '').toLowerCase();
    const isPublic = event.comment?.jsdPublic !== false;
    return accountType === 'customer' && isPublic ? ['customerReply'] : [];
  }

  if (event.eventType !== 'avi:jira:updated:issue' && event.eventType !== 'avi:jira:assigned:issue') {
    return [];
  }

  const items = changelogItems(event);
  const triggers = [];

  const assigneeChange = items.find(item => ['assignee', 'assigneeaccountid'].includes(fieldKey(item)));
  if (assigneeChange && (assigneeChange.to == null || String(assigneeChange.to).trim() === '')) {
    triggers.push('unassigned');
  }
  if (items.some(item => fieldKey(item) === 'priority')) triggers.push('priorityChanged');
  if (items.some(item => fieldKey(item) === 'status')) triggers.push('statusChanged');

  return [...new Set(triggers)];
}

export function cooldownMinutesForRule(rule = {}) {
  if (rule.trigger === 'untouched') return Math.max(15, Number(rule.untouchedMinutes || 0));
  if (rule.trigger === 'slaThreshold') return Math.max(10, Math.min(60, Number(rule.slaThresholdMinutes || 10)));
  return 2;
}

export function executionIsCoolingDown({ lastExecutedAt, now = new Date(), cooldownMinutes = 2 }) {
  if (!lastExecutedAt) return false;
  const last = new Date(lastExecutedAt);
  if (Number.isNaN(last.getTime())) return false;
  return now.getTime() - last.getTime() < Math.max(0, Number(cooldownMinutes || 0)) * 60_000;
}

// Compare the stored on-shift snapshot with the current one. A missing or stale snapshot (e.g. routing
// was off for days) is only a baseline: acting on it would treat everyone who changed since as a shift
// boundary and mass-reassign tickets.
export function diffShiftState({ previous, current = [], now = new Date(), maxAgeMinutes = 15 }) {
  const at = new Date(previous?.at);
  if (!Array.isArray(previous?.onShift) || Number.isNaN(at.getTime()) || now.getTime() - at.getTime() > maxAgeMinutes * 60_000) {
    return { baseline: true, started: [], ended: [] };
  }
  return {
    baseline: false,
    started: current.filter(id => !previous.onShift.includes(id)),
    ended: previous.onShift.filter(id => !current.includes(id))
  };
}
