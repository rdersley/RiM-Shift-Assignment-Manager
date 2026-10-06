export function shouldPreserveOwner({ currentAssignee, eligibleAccountIds, forceReassign = false }) {
  return !forceReassign && !!currentAssignee && eligibleAccountIds.includes(currentAssignee);
}

export function selectAssignee({ strategy, eligibleAccountIds, loads = {}, lastAssignedAccountId = null, fixedOrder = [] }) {
  if (!eligibleAccountIds?.length) return null;
  const eligible = [...new Set(eligibleAccountIds)];

  switch (strategy) {
    case 'leastLoaded':
      return eligible.slice().sort((a, b) => (loads[a] ?? 0) - (loads[b] ?? 0) || a.localeCompare(b))[0];
    case 'fixedOrder': {
      const found = fixedOrder.find(id => eligible.includes(id));
      return found || eligible[0];
    }
    case 'roundRobin': {
      if (!lastAssignedAccountId || !eligible.includes(lastAssignedAccountId)) return eligible[0];
      const idx = eligible.indexOf(lastAssignedAccountId);
      return eligible[(idx + 1) % eligible.length];
    }
    case 'random':
      return eligible[Math.floor(Math.random() * eligible.length)];
    default:
      throw new Error(`Unsupported assignment strategy: ${strategy}`);
  }
}

// Full decision for one rule against one issue, including the shift-end and no-agent policies.
export function decideForRule({ rule, issue, eligibleAccountIds, loads = {}, lastAssignedAccountId = null }) {
  if (rule.trigger === 'shiftEnd' && rule.shiftEndPolicy === 'keep') {
    return { action: 'keep', assigneeAccountId: issue.assigneeAccountId, reason: 'SHIFT_END_KEEP' };
  }
  if (rule.trigger === 'shiftEnd' && rule.shiftEndPolicy === 'unassign') {
    return issue.assigneeAccountId
      ? { action: 'unassign', reason: 'SHIFT_END_UNASSIGN' }
      : { action: 'none', reason: 'ALREADY_UNASSIGNED' };
  }
  const result = evaluateAssignment({ rule, issue, eligibleAccountIds, loads, lastAssignedAccountId });
  if (result.action === 'none' && result.reason === 'NO_ELIGIBLE_AGENT' && rule.noAgentPolicy === 'unassign' && issue.assigneeAccountId) {
    return { action: 'unassign', reason: 'NO_ELIGIBLE_AGENT_UNASSIGN' };
  }
  // A forced reassignment can land on the person who already owns the ticket; don't write a no-op.
  if (result.action === 'assign' && result.assigneeAccountId === issue.assigneeAccountId) {
    return { action: 'keep', assigneeAccountId: issue.assigneeAccountId, reason: 'ALREADY_ASSIGNED' };
  }
  return result;
}

export function evaluateAssignment({ rule, issue, eligibleAccountIds, loads, lastAssignedAccountId }) {
  if (!eligibleAccountIds.length) {
    return { action: 'none', reason: 'NO_ELIGIBLE_AGENT' };
  }
  if (shouldPreserveOwner({
    currentAssignee: issue.assigneeAccountId,
    eligibleAccountIds,
    forceReassign: rule.forceReassign
  })) {
    return { action: 'keep', assigneeAccountId: issue.assigneeAccountId, reason: 'OWNER_CONTINUITY' };
  }
  const selected = selectAssignee({
    strategy: rule.assignmentStrategy,
    eligibleAccountIds,
    loads,
    lastAssignedAccountId,
    fixedOrder: rule.fixedOrder || []
  });
  return { action: 'assign', assigneeAccountId: selected, reason: `STRATEGY_${rule.assignmentStrategy}` };
}
