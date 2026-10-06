import { kvs, WhereConditions } from '@forge/kvs';

// KVS queries return at most 100 items per page; follow the cursor up to `max`.
export async function listByPrefix(prefix, max = 500) {
  const values = [];
  let cursor;
  do {
    let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(Math.min(100, max - values.length));
    if (cursor) query = query.cursor(cursor);
    const page = await query.getMany();
    values.push(...(page.results || []).map(item => item.value));
    cursor = page.nextCursor;
  } while (cursor && values.length < max);
  return values;
}
