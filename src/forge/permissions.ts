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
