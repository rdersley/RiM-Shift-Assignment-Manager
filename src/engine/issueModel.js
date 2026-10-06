// The JSM "Request Type" field id differs per site (customfield_10010 is only the common default),
// so find it by shape rather than by id.
export function findRequestTypeId(fields = {}) {
  for (const value of Object.values(fields)) {
    if (value && typeof value === 'object' && value.requestType?.id != null) return String(value.requestType.id);
  }
  return '';
}

export function toIssueModel(issue) {
  const fields = issue?.fields || {};
  return {
    key: issue?.key,
    projectId: String(fields.project?.id || ''),
    issueTypeId: String(fields.issuetype?.id || ''),
    requestTypeId: findRequestTypeId(fields),
    statusId: String(fields.status?.id || ''),
    priorityId: String(fields.priority?.id || ''),
    assigneeAccountId: fields.assignee?.accountId || null,
    reporterAccountId: fields.reporter?.accountId || null,
    labels: fields.labels || [],
    componentIds: (fields.components || []).map(c => String(c.id)),
    fields
  };
}
