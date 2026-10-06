import { jiraEventHandler as coreJiraEventHandler, scheduledHandler as coreScheduledHandler } from './index.js';
import { getRoutingMode } from './routingSettings.js';
import { runHousekeeping } from './housekeeping.js';

async function currentRoutingMode() {
  try {
    return await getRoutingMode();
  } catch (error) {
    console.error('Unable to read automatic routing setting; failing closed.', error);
    return 'off';
  }
}

export async function jiraEventHandler(event, context) {
  const mode = await currentRoutingMode();
  if (mode === 'off') {
    console.log('Shift & Assignment Manager automatic routing is OFF; Jira event ignored.');
    return;
  }
  return coreJiraEventHandler(event, context, { dryRun: mode !== 'on' });
}

export async function scheduledHandler(request, context) {
  // Storage clean-up runs even when routing is off; it never touches Jira.
  try { await runHousekeeping(); } catch (error) { console.error('Housekeeping failed.', error); }
  const mode = await currentRoutingMode();
  if (mode === 'off') {
    console.log('Shift & Assignment Manager automatic routing is OFF; scheduled evaluation skipped.');
    return;
  }
  return coreScheduledHandler(request, context, { dryRun: mode !== 'on' });
}
