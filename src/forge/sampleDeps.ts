// Forge adapter: real SampleDeps. Every call is made as the app.
import api, { route } from '@forge/api';
import { isTitleConflict, PageTitleConflictError, type SampleDeps } from '../domain/sampleData';
import { createAppRepos } from './kvsRepos';
import { fetchBody, getPageMeta } from './confluence';

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };
const enc = (s: string): string => encodeURIComponent(s);

async function ok<T extends { ok: boolean; status: number }>(res: T, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} failed: ${res.status}`);
  return res;
}

export async function findSpaceId(spaceKey: string): Promise<string> {
  const res = await ok(
    await api.asApp().requestConfluence(route`/wiki/api/v2/spaces?keys=${enc(spaceKey)}`, { headers: JSON_HEADERS }),
    'Confluence find space',
  );
  const j = (await res.json()) as { results?: { id?: unknown }[] };
  const id = j.results?.[0]?.id;
  if (typeof id !== 'string' || id === '') throw new Error(`Confluence space "${spaceKey}" was not found.`);
  return id;
}

export async function createPage(spaceId: string, title: string, xhtml: string): Promise<{ id: string }> {
  const created = await api.asApp().requestConfluence(route`/wiki/api/v2/pages`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ spaceId, status: 'current', title, body: { representation: 'storage', value: xhtml } }),
  });
  if (!created.ok && created.status === 400) {
    const text = await created.text().catch(() => '');
    if (isTitleConflict(created.status, text)) throw new PageTitleConflictError();
  }
  const res = await ok(created, 'Confluence create page');
  const j = (await res.json()) as { id?: unknown };
  if (typeof j.id !== 'string') throw new Error('Confluence create page returned no id');
  return { id: j.id };
}

export async function updatePage(pageId: string, title: string, xhtml: string, nextVersion: number): Promise<void> {
  await ok(
    await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${enc(pageId)}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        id: pageId,
        status: 'current',
        title,
        body: { representation: 'storage', value: xhtml },
        version: { number: nextVersion, message: 'Canon sample data' },
      }),
    }),
    'Confluence update page',
  );
}

export async function pageExists(pageId: string): Promise<boolean> {
  const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${enc(pageId)}`, {
    headers: { Accept: 'application/json' },
  });
  return res.status === 200;
}

export async function createIssue(projectKey: string, summary: string): Promise<{ key: string }> {
  const res = await ok(
    await api.asApp().requestJira(route`/rest/api/3/issue`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ fields: { project: { key: projectKey }, issuetype: { name: 'Task' }, summary } }),
    }),
    'Jira create issue',
  );
  const j = (await res.json()) as { key?: unknown };
  if (typeof j.key !== 'string') throw new Error('Jira create issue returned no key');
  return { key: j.key };
}

export async function issueExists(key: string): Promise<boolean> {
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${enc(key)}?fields=summary`, {
    headers: { Accept: 'application/json' },
  });
  return res.status === 200;
}

export async function moveIssueToCategory(key: string, category: 'indeterminate' | 'done'): Promise<void> {
  const res = await ok(
    await api.asApp().requestJira(route`/rest/api/3/issue/${enc(key)}/transitions`, {
      headers: { Accept: 'application/json' },
    }),
    'Jira list transitions',
  );
  const j = (await res.json()) as { transitions?: { id?: unknown; to?: { statusCategory?: { key?: unknown } } }[] };
  const t = j.transitions?.find((x) => x.to?.statusCategory?.key === category && typeof x.id === 'string');
  if (!t) throw new Error(`No transition from ${key} to status category "${category}".`);
  await ok(
    await api.asApp().requestJira(route`/rest/api/3/issue/${enc(key)}/transitions`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ transition: { id: t.id } }),
    }),
    'Jira transition issue',
  );
}

export function createSampleDeps(): SampleDeps {
  return {
    repos: createAppRepos(),
    now: () => new Date().toISOString(),
    getPageMeta,
    fetchBody,
    findSpaceId,
    createPage,
    updatePage,
    pageExists,
    createIssue,
    issueExists,
    moveIssueToCategory,
  };
}
