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

/** Whether the current user can browse the project. Any failure is false. */
export async function canBrowseProject(projectKey: string): Promise<boolean> {
  try {
    const res = await api
      .asUser()
      .requestJira(route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=BROWSE_PROJECTS`, {
        headers: { Accept: 'application/json' },
      });
    if (!res.ok) return false;
    const j = (await res.json()) as { permissions?: { BROWSE_PROJECTS?: { havePermission?: unknown } } };
    return j.permissions?.BROWSE_PROJECTS?.havePermission === true;
  } catch {
    return false;
  }
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

/**
 * The subset of `issueKeys` the current user can browse (issue security aware): GET each issue as
 * the user, 10 at a time. Any non-200 or error hides that issue.
 */
export async function visibleIssues(issueKeys: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const keys = issueKeys.filter((k) => /^[A-Z][A-Z0-9_]+-[0-9]+$/.test(k));
  for (let i = 0; i < keys.length; i += 10) {
    await Promise.all(
      keys.slice(i, i + 10).map(async (key) => {
        try {
          const res = await api
            .asUser()
            .requestJira(route`/rest/api/3/issue/${key}?fields=none`, { headers: { Accept: 'application/json' } });
          if (res.ok) out.add(key);
        } catch {
          // hidden
        }
      }),
    );
  }
  return out;
}
