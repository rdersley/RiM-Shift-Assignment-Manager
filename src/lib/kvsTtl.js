import { kvs } from '@forge/kvs';

// Store with an expiry so KVS deletes the entry itself. If the store rejects the TTL option,
// write without it: the hourly housekeeping sweep still removes old entries.
export async function setWithTtl(key, value, days) {
  try {
    await kvs.set(key, value, { ttl: { value: Math.max(1, Math.ceil(days)), unit: 'DAYS' } });
  } catch (error) {
    console.warn(`KVS TTL write failed for ${key}; storing without expiry.`, error?.message || error);
    await kvs.set(key, value);
  }
}
