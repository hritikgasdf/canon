import { approveVersion, markControlled, type PageMeta } from './approve';
import { appendAudit } from './audit';
import { bindIssue, BindError } from './bind';
import type { Repos } from './repos';
import { SAMPLE_PAGE_TITLE, SAMPLE_V2_XHTML, SAMPLE_V3_XHTML, SAMPLE_V4_XHTML } from './sampleContent';
import type { BodyFetcher } from './supersede';
import type { SampleState } from './types';

export type SampleDeps = {
  repos: Repos;
  now(): string;
  getPageMeta(pageId: string): Promise<PageMeta>;
  fetchBody: BodyFetcher;
  findSpaceId(spaceKey: string): Promise<string>;
  createPage(spaceId: string, title: string, xhtml: string): Promise<{ id: string }>;
  updatePage(pageId: string, title: string, xhtml: string, nextVersion: number): Promise<void>;
  pageExists(pageId: string): Promise<boolean>;
  createIssue(projectKey: string, summary: string): Promise<{ key: string }>;
  issueExists(key: string): Promise<boolean>;
  moveIssueToCategory(key: string, category: 'indeterminate' | 'done'): Promise<void>;
};

export const SAMPLE_APPROVER = 'sample:priya-nair';
export const SAMPLE_IMPLEMENTER = 'sample:arjun-mehta';

export const SAMPLE_SUMMARIES = {
  done: '[Sample] Quarterly processor failover drill (Arjun Mehta)',
  hero: '[Sample] Switch card authorisation to backup processor for primary maintenance (implementer Arjun Mehta, checker Lena Ortiz)',
  second: '[Sample] Backup processor certificate rotation (Arjun Mehta)',
  todo: '[Sample] Next quarter failover rehearsal (Arjun Mehta)',
} as const;

type IssueRole = keyof SampleState['issues'];
const ROLES: IssueRole[] = ['done', 'hero', 'second', 'todo'];

export type LoadResult = { status: 'LOADED' | 'ALREADY_LOADED'; state: SampleState };

async function bindTolerant(deps: SampleDeps, issueKey: string, pageId: string) {
  try {
    return await bindIssue(deps.repos, { issueKey, pageId, actor: SAMPLE_IMPLEMENTER, at: deps.now() });
  } catch (e) {
    if (e instanceof BindError && e.code === 'ALREADY_BOUND') return null;
    throw e;
  }
}

export async function loadSampleData(
  deps: SampleDeps,
  input: { spaceKey: string; projectKey: string; actor: string },
): Promise<LoadResult> {
  const { repos } = deps;
  const { spaceKey, projectKey, actor } = input;
  const prior = await repos.sample.get();
  const sameTarget = prior !== null && prior.spaceKey === spaceKey && prior.projectKey === projectKey;

  let pageLives = false;
  const issueLives: Record<IssueRole, boolean> = { done: false, hero: false, second: false, todo: false };
  if (sameTarget) {
    pageLives = await deps.pageExists(prior.pageId);
    for (const r of ROLES) issueLives[r] = await deps.issueExists(prior.issues[r]);
    if (pageLives && ROLES.every((r) => issueLives[r])) return { status: 'ALREADY_LOADED', state: prior };
  }

  // Page: only created when missing. The app is the last editor, so the approver persona passes SoD.
  const freshPage = !(sameTarget && pageLives);
  let pageId: string;
  if (!freshPage) {
    pageId = prior.pageId;
  } else {
    const spaceId = await deps.findSpaceId(spaceKey);
    const page = await deps.createPage(spaceId, SAMPLE_PAGE_TITLE, `<p><em>Initial draft.</em></p>${SAMPLE_V2_XHTML}`);
    pageId = page.id;
    await deps.updatePage(pageId, SAMPLE_PAGE_TITLE, SAMPLE_V2_XHTML, 2);
    await markControlled(repos, await deps.getPageMeta(pageId), { actor, at: deps.now(), policy: 'approved-only' });
    await approveVersion(repos, deps.fetchBody, await deps.getPageMeta(pageId), {
      version: 2,
      actor: SAMPLE_APPROVER,
      at: deps.now(),
    });
  }

  const issues = {} as SampleState['issues'];
  const created: Record<IssueRole, boolean> = { done: false, hero: false, second: false, todo: false };
  for (const r of ROLES) {
    if (sameTarget && issueLives[r]) {
      issues[r] = prior.issues[r];
    } else {
      issues[r] = (await deps.createIssue(projectKey, SAMPLE_SUMMARIES[r])).key;
      created[r] = true;
    }
  }

  // Done issue: bound at v2, then closed. Closed directly in case the issue event arrives later.
  if (freshPage || created.done) {
    const bound = await bindTolerant(deps, issues.done, pageId);
    if (created.done) await deps.moveIssueToCategory(issues.done, 'done');
    const binding = bound ?? (await repos.bindings.get(`${issues.done}.${pageId}`));
    if (binding !== null) {
      const proc = await repos.procedures.get(pageId);
      const hasV2 = proc?.approved.some((a) => a.version === 2) === true;
      await repos.bindings.put({
        ...binding,
        boundVersion: hasV2 ? 2 : binding.boundVersion,
        closedAt: deps.now(),
      });
    }
  }

  if (freshPage) {
    await deps.updatePage(pageId, SAMPLE_PAGE_TITLE, SAMPLE_V3_XHTML, 3);
    await approveVersion(repos, deps.fetchBody, await deps.getPageMeta(pageId), {
      version: 3,
      actor: SAMPLE_APPROVER,
      at: deps.now(),
    });
  }

  for (const r of ['hero', 'second'] as const) {
    // Bind before moving to In Progress so the auto-bind trigger sees an existing binding and skips.
    await bindTolerant(deps, issues[r], pageId);
    if (created[r]) await deps.moveIssueToCategory(issues[r], 'indeterminate');
  }

  const settings = await repos.settings.get();
  // Never overwrite an admin's existing mapping; only fill it in on a fresh site.
  const mapKey = `${projectKey}/Task`;
  if (!Object.prototype.hasOwnProperty.call(settings.autoBind, mapKey)) {
    await repos.settings.put({ ...settings, autoBind: { ...settings.autoBind, [mapKey]: pageId } });
  }

  await appendAudit(repos.audit, {
    issueKey: issues.hero,
    type: 'SAMPLE_LOADED',
    actor,
    at: deps.now(),
    payload: { pageId, spaceKey, projectKey, issues },
  });

  const state: SampleState = { spaceKey, projectKey, pageId, issues, loadedAt: deps.now() };
  if (!freshPage && prior?.v4PublishedAt !== undefined) state.v4PublishedAt = prior.v4PublishedAt;
  await repos.sample.put(state);
  return { status: 'LOADED', state };
}

export class SampleError extends Error {
  code: 'NOT_LOADED';
  constructor(code: 'NOT_LOADED', message: string) {
    super(message);
    this.name = 'SampleError';
    this.code = code;
  }
}

export type ResetResult = { status: 'RESET'; previous: SampleState; state: SampleState };

/** Retires the current sample run (audit first, then close bindings), frees the page title, then reloads. */
export async function resetSampleData(deps: SampleDeps, input: { actor: string }): Promise<ResetResult> {
  const { repos } = deps;
  const prev = await repos.sample.get();
  if (prev === null) throw new SampleError('NOT_LOADED', 'Sample data is not loaded.');

  for (const r of ROLES) {
    const issueKey = prev.issues[r];
    for (const b of await repos.bindings.listByIssue(issueKey)) {
      if (b.pageId !== prev.pageId || b.closedAt !== undefined) continue;
      await appendAudit(repos.audit, {
        issueKey,
        type: 'SAMPLE_RESET',
        actor: input.actor,
        at: deps.now(),
        payload: { pageId: prev.pageId, bindingId: b.id },
      });
      await repos.bindings.put({ ...b, closedAt: deps.now() });
    }
  }

  if (await deps.pageExists(prev.pageId)) {
    const meta = await deps.getPageMeta(prev.pageId);
    const body = await deps.fetchBody(prev.pageId, meta.currentVersion);
    const stamp = deps.now().slice(0, 16).replace('T', ' ');
    await deps.updatePage(prev.pageId, `${SAMPLE_PAGE_TITLE} (replaced ${stamp} UTC)`, body, meta.currentVersion + 1);
  }
  const proc = await repos.procedures.get(prev.pageId);
  if (proc) await repos.procedures.put({ ...proc, controlled: false });

  await repos.sample.clear();

  const settings = await repos.settings.get();
  const mapKey = `${prev.projectKey}/Task`;
  if (settings.autoBind[mapKey] === prev.pageId) {
    const autoBind = { ...settings.autoBind };
    delete autoBind[mapKey];
    await repos.settings.put({ ...settings, autoBind });
  }

  const { state } = await loadSampleData(deps, {
    spaceKey: prev.spaceKey,
    projectKey: prev.projectKey,
    actor: input.actor,
  });
  return { status: 'RESET', previous: prev, state };
}

export type PublishResult = { status: 'PUBLISHED' | 'ALREADY_PUBLISHED'; version: number };

/** Publishes v4 as a draft. Does not approve: a human approves it in the byline. */
export async function publishSampleV4(deps: SampleDeps, input: { actor: string }): Promise<PublishResult> {
  const state = await deps.repos.sample.get();
  if (state === null) throw new Error('Sample data is not loaded.');
  const meta = await deps.getPageMeta(state.pageId);
  if (state.v4PublishedAt !== undefined && meta.currentVersion >= 4) {
    return { status: 'ALREADY_PUBLISHED', version: meta.currentVersion };
  }
  if ((await deps.fetchBody(state.pageId, meta.currentVersion)) === SAMPLE_V4_XHTML) {
    return { status: 'ALREADY_PUBLISHED', version: meta.currentVersion };
  }
  const next = meta.currentVersion + 1;
  await deps.updatePage(state.pageId, meta.title, SAMPLE_V4_XHTML, next);
  const at = deps.now();
  await deps.repos.sample.put({ ...state, v4PublishedAt: at });
  await appendAudit(deps.repos.audit, {
    issueKey: state.issues.hero,
    type: 'SAMPLE_V4_PUBLISHED',
    actor: input.actor,
    at,
    payload: { pageId: state.pageId, version: next },
  });
  return { status: 'PUBLISHED', version: next };
}
