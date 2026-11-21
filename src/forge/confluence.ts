import api, { route } from '@forge/api';
import type { PageMeta } from '../domain/approve';
import type { BodyFetcher } from '../domain/supersede';

type PageResponse = {
  title?: string;
  spaceId?: string;
  version?: { number?: number; authorId?: string; minorEdit?: boolean };
  body?: { storage?: { value?: string } };
};

const enc = (s: string): string => encodeURIComponent(s);

export async function getPageMeta(pageId: string): Promise<PageMeta> {
  const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${enc(pageId)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Confluence getPage failed: ${res.status}`);
  const j = (await res.json()) as PageResponse;
  const v = j.version;
  if (typeof j.title !== 'string' || typeof v?.number !== 'number' || typeof v.authorId !== 'string') {
    throw new Error('Confluence getPage returned an unexpected shape');
  }
  return { pageId, title: j.title, currentVersion: v.number, lastEditorId: v.authorId, minorEdit: v.minorEdit === true };
}

export const fetchBody: BodyFetcher = async (pageId, version) => {
  const res = await api
    .asApp()
    .requestConfluence(route`/wiki/api/v2/pages/${enc(pageId)}?version=${String(version)}&body-format=storage`, {
      headers: { Accept: 'application/json' },
    });
  if (!res.ok) throw new Error(`Confluence fetch body failed: ${res.status}`);
  const j = (await res.json()) as PageResponse;
  const value = j.body?.storage?.value;
  if (typeof value !== 'string') throw new Error('Confluence page version has no storage body');
  return value;
};

export async function canUserView(pageId: string): Promise<boolean> {
  try {
    const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${enc(pageId)}`, {
      headers: { Accept: 'application/json' },
    });
    return res.ok;
  } catch {
    return false;
  }
}
