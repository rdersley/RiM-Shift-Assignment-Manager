// The Backup & restore page is the app's "Get started" admin page, which Jira doesn't list in the
// Apps sidebar. Its address is /jira/settings/apps/get-started/{appId}/{environmentId}, and both ids
// are in the module's localId: ari:cloud:ecosystem::extension/{appId}/{environmentId}/static/{key}.
export function backupPagePath(context = {}) {
  const match = /extension\/([0-9a-f-]{36})\/([0-9a-f-]{36})\//i.exec(String(context.localId || ''));
  const appId = match?.[1];
  const environmentId = context.environmentId || match?.[2];
  return appId && environmentId ? `/jira/settings/apps/get-started/${appId}/${environmentId}` : null;
}
