import api, { route } from '@forge/api';

export async function assertAdmin() {
  const response = await api.asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
  if (!response.ok) throw new Error(`Unable to verify Jira admin permission (${response.status})`);
  const body = await response.json();
  if (!body?.permissions?.ADMINISTER?.havePermission) throw new Error('Jira administrator permission is required.');
}
