import { kvs, WhereConditions } from '@forge/kvs';
import { expiredAuditRanges, normaliseRetentionDays } from './engine/audit.js';

export const AUDIT_RETENTION_KEY = 'settings:audit-retention-days';
const LAST_RUN_KEY = 'housekeeping:last-run';
const CURSOR_PREFIX = 'housekeeping:cursor:';
// Cooldown markers written before 0.9 have no TTL. Nothing needs one older than this.
const EXECUTION_MAX_AGE_DAYS = 30;
const EXECUTION_PREFIXES = ['execution:', 'shadow-execution:'];
const MAX_DELETES_PER_RUN = 500;
const DELETE_CHUNK = 20;

export async function getAuditRetentionDays() {
  return normaliseRetentionDays(await kvs.get(AUDIT_RETENTION_KEY));
}

async function deleteKeys(keys) {
  for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
    await kvs.batchDelete(keys.slice(i, i + DELETE_CHUNK).map(key => ({ key })));
  }
}

async function pruneRange({ from, to }, budget) {
  let deleted = 0;
  while (deleted < budget) {
    const page = await kvs.query().where('key', WhereConditions.between(from, to)).limit(Math.min(100, budget - deleted)).getMany();
    const keys = (page.results || []).map(item => item.key);
    if (!keys.length) break;
    await deleteKeys(keys);
    deleted += keys.length;
    if (!page.nextCursor) break;
  }
  return deleted;
}

// Walks one page per run through a prefix, resuming where the last run stopped.
async function sweepExecutionMarkers(prefix, cutoff) {
  const cursorKey = `${CURSOR_PREFIX}${prefix}`;
  const cursor = await kvs.get(cursorKey);
  let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
  if (cursor) query = query.cursor(cursor);
  const page = await query.getMany();
  const stale = (page.results || []).filter(item => {
    const at = new Date(item.value);
    return Number.isNaN(at.getTime()) || at < cutoff;
  }).map(item => item.key);
  await deleteKeys(stale);
  if (page.nextCursor) await kvs.set(cursorKey, page.nextCursor);
  else await kvs.delete(cursorKey);
  return stale.length;
}

// Runs from the scheduled trigger whatever the routing mode: it only touches the app's own storage.
export async function runHousekeeping(now = new Date()) {
  const lastRun = new Date(await kvs.get(LAST_RUN_KEY));
  if (!Number.isNaN(lastRun.getTime()) && now - lastRun < 60 * 60_000) return { skipped: true };
  await kvs.set(LAST_RUN_KEY, now.toISOString());

  const retentionDays = await getAuditRetentionDays();
  const auditCutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  let auditDeleted = 0;
  for (const range of expiredAuditRanges(auditCutoff)) {
    auditDeleted += await pruneRange(range, MAX_DELETES_PER_RUN - auditDeleted);
  }

  const executionCutoff = new Date(now.getTime() - EXECUTION_MAX_AGE_DAYS * 86_400_000);
  let executionDeleted = 0;
  for (const prefix of EXECUTION_PREFIXES) executionDeleted += await sweepExecutionMarkers(prefix, executionCutoff);

  if (auditDeleted || executionDeleted) console.log(`Housekeeping removed ${auditDeleted} audit entries and ${executionDeleted} cooldown markers.`);
  return { skipped: false, retentionDays, auditDeleted, executionDeleted };
}
