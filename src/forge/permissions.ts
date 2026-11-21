// Forge adapter: permission checks shared by resolvers.
import api, { route } from '@forge/api';

export async function isProjectAdmin(projectKey: string): Promise<boolean> {
  const res = await api
    .asUser()
    .requestJira(route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=ADMINISTER_PROJECTS`, {
      headers: { Accept: 'application/json' },
    });
  if (!res.ok) return false;
  const j = (await res.json()) as { permissions?: { ADMINISTER_PROJECTS?: { havePermission?: unknown } } };
  return j.permissions?.ADMINISTER_PROJECTS?.havePermission === true;
}

/** Whether the current user is a Jira administrator. Any failure is false. */
export async function isJiraAdmin(): Promise<boolean> {
  try {
    const res = await api.asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { permissions?: { ADMINISTER?: { havePermission?: unknown } } };
    return j.permissions?.ADMINISTER?.havePermission === true;
  } catch {
    return false;
  }
}

/** Whether `accountId` can browse the issue, checked as the app. Any failure is false. */
export async function canUserBrowseIssue(accountId: string, issueKey: string): Promise<boolean> {
  try {
    const res = await api
      .asApp()
      .requestJira(
        route`/rest/api/3/user/permission/search?permissions=BROWSE_PROJECTS&issueKey=${issueKey}&accountId=${accountId}`,
        { headers: { Accept: 'application/json' } },
      );
    if (!res.ok) {
      console.warn(JSON.stringify({ tag: 'canon-permission-check', check: 'browse', status: res.status }));
      return false;
    }
    const j = (await res.json()) as unknown;
    return Array.isArray(j) && j.some((u) => (u as { accountId?: unknown } | null)?.accountId === accountId);
  } catch {
    return false;
  }
}
