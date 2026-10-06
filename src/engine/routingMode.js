// Background routing modes:
//   off    – background events and scans do nothing (default)
//   shadow – background routing is evaluated and written to the audit log, but Jira is never changed
//   on     – background routing changes Jira assignees
export const ROUTING_MODES = ['off', 'shadow', 'on'];

// `stored` is the routing-mode setting; `legacyEnabled` is the pre-0.9 boolean switch.
export function resolveRoutingMode(stored, legacyEnabled) {
  if (ROUTING_MODES.includes(stored)) return stored;
  return legacyEnabled === true ? 'on' : 'off';
}

export function normaliseRequestedMode(value) {
  return ROUTING_MODES.includes(value) ? value : 'off';
}
