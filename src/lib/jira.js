import api, { route } from '@forge/api';

export function jiraClient(actor = 'user') {
  return actor === 'app' ? api.asApp() : api.asUser();
}

export async function getIssue(issueKey, actor = 'user') {
  const res = await jiraClient(actor).requestJira(route`/rest/api/3/issue/${issueKey}`);
  if (!res.ok) throw new Error(`Unable to load ${issueKey} (${res.status})`);
  return res.json();
}

// Enhanced JQL search. The legacy /rest/api/3/search endpoint has been removed by Atlassian.
export async function searchIssueKeys(jql, actor = 'app', max = 100) {
  const keys = [];
  let nextPageToken;
  do {
    const pageSize = Math.min(100, max - keys.length);
    const res = nextPageToken
      ? await jiraClient(actor).requestJira(route`/rest/api/3/search/jql?jql=${jql}&maxResults=${pageSize}&fields=assignee&nextPageToken=${nextPageToken}`)
      : await jiraClient(actor).requestJira(route`/rest/api/3/search/jql?jql=${jql}&maxResults=${pageSize}&fields=assignee`);
    if (!res.ok) throw new Error(`Unable to search Jira (${res.status})`);
    const body = await res.json();
    keys.push(...(body.issues || []).map(issue => issue.key || issue.id).filter(Boolean));
    nextPageToken = body.isLast === false ? body.nextPageToken : undefined;
  } while (nextPageToken && keys.length < max);
  return keys;
}

// Full issues (chosen fields, optionally with changelog) via the enhanced JQL search.
export async function searchIssues(jql, { fields = [], expand, max = 1000, actor = 'user' } = {}) {
  const issues = [];
  let nextPageToken;
  let truncated = false;
  do {
    const res = await jiraClient(actor).requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jql, fields, maxResults: Math.min(100, max - issues.length), ...(expand ? { expand } : {}), ...(nextPageToken ? { nextPageToken } : {}) })
    });
    if (!res.ok) throw new Error(`Unable to search Jira (${res.status})`);
    const body = await res.json();
    issues.push(...(body.issues || []));
    nextPageToken = body.isLast === false ? body.nextPageToken : undefined;
    if (nextPageToken && issues.length >= max) truncated = true;
  } while (nextPageToken && issues.length < max);
  return { issues, truncated };
}

export async function countIssues(jql, actor = 'user') {
  const res = await jiraClient(actor).requestJira(route`/rest/api/3/search/approximate-count`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jql })
  });
  if (!res.ok) throw new Error(`Unable to count Jira issues (${res.status})`);
  const body = await res.json();
  return Number(body.count) || 0;
}

export function quoteJql(value = '') {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
