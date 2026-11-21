import api, { route } from '@forge/api';
import type { IssueSummary } from '../domain/issueSummary';

/** Writes the canon.gate issue property so JQL can search on canonState / canonBoundVersion / canonBindingCount. */
export async function putCanonGateProperty(issueKey: string, summary: IssueSummary): Promise<void> {
  // Issue properties are readable by anyone who can browse the issue, so the body is an explicit
  // allow-list. Never spread `summary` here: it carries pageIds, which must not be published.
  const body = {
    state: summary.state,
    boundVersion: summary.boundVersion,
    targetVersion: summary.targetVersion,
    bindingCount: summary.bindingCount,
    updatedAt: new Date().toISOString(),
  };
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/properties/canon.gate`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jira canon.gate property PUT failed: ${res.status}`);
}
