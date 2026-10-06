import Resolver from '@forge/resolver';
import { kvs } from '@forge/kvs';
import { assertAdmin } from './lib/admin.js';
import { normaliseRequestedMode, resolveRoutingMode } from './engine/routingMode.js';

// Pre-0.9 boolean switch. Still read so an existing "on" install stays on after upgrade.
export const ROUTING_SETTINGS_KEY = 'settings:automatic-routing';
export const ROUTING_MODE_KEY = 'settings:routing-mode';

const resolver = new Resolver();

// Defaults to 'off' when nothing is stored.
export async function getRoutingMode() {
  const [stored, legacy] = await Promise.all([kvs.get(ROUTING_MODE_KEY), kvs.get(ROUTING_SETTINGS_KEY)]);
  return resolveRoutingMode(stored, legacy);
}

resolver.define('getRoutingSettings', async () => {
  await assertAdmin();
  return { routingMode: await getRoutingMode() };
});

resolver.define('setRoutingMode', async ({ payload }) => {
  await assertAdmin();
  const mode = normaliseRequestedMode(payload?.mode);
  if (mode === 'on' && String(payload?.confirmation || '').trim().toUpperCase() !== 'ENABLE') {
    throw new Error('Type ENABLE to turn on live automatic routing.');
  }
  await Promise.all([kvs.set(ROUTING_MODE_KEY, mode), kvs.set(ROUTING_SETTINGS_KEY, mode === 'on')]);
  return { routingMode: mode };
});

export const handler = resolver.getDefinitions();
