import api, { route } from '@forge/api';
import type { IssueSummary } from '../domain/issueSummary';

/** Writes the canon.gate issue property so JQL can search on canonState / canonBoundVersion / canonBindingCount. */
export async function putCanonGateProperty(issueKey: string, summary: IssueSummary): Promise<void> {
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/properties/canon.gate`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...summary, updatedAt: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Jira canon.gate property PUT failed: ${res.status}`);
}
