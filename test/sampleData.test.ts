import { describe, expect, it } from 'vitest';
import { approveVersion } from '../src/domain/approve';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import { isTitleConflict, loadSampleData, PageTitleConflictError, publishSampleV4, resetSampleData, SAMPLE_SUMMARIES, type SampleDeps } from '../src/domain/sampleData';
import { SAMPLE_V2_XHTML, SAMPLE_V3_XHTML, SAMPLE_V4_XHTML } from '../src/domain/sampleContent';

function makeDeps() {
  const repos = createMemoryRepos();
  const pages = new Map<string, { title: string; bodies: string[] }>();
  const issues = new Map<string, { summary: string; category: string }>();
  const writes: string[] = [];
  let clock = 0;
  const deps: SampleDeps = {
    repos,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
    async getPageMeta(pageId) {
      const p = pages.get(pageId);
      if (!p) throw new Error('no page');
      return { pageId, title: p.title, currentVersion: p.bodies.length, lastEditorId: 'app', minorEdit: false };
    },
    async fetchBody(pageId, version) {
      const b = pages.get(pageId)?.bodies[version - 1];
      if (b === undefined) throw new Error('no body');
      return b;
    },
    async findSpaceId(key) {
      if (key !== 'DOCS') throw new Error(`Confluence space "${key}" was not found.`);
      return 'space-1';
    },
    async createPage(_space, title, xhtml) {
      writes.push('createPage');
      const id = `p${pages.size + 1}`;
      pages.set(id, { title, bodies: [xhtml] });
      return { id };
    },
    async updatePage(pageId, title, xhtml, nextVersion) {
      writes.push(`updatePage:${nextVersion}`);
      const p = pages.get(pageId)!;
      if (nextVersion !== p.bodies.length + 1) throw new Error('version conflict');
      p.bodies.push(xhtml);
      p.title = title;
    },
    async pageExists(id) {
      return pages.has(id);
    },
    async createIssue(project, summary) {
      writes.push('createIssue');
      const key = `${project}-${issues.size + 1}`;
      issues.set(key, { summary, category: 'new' });
      return { key };
    },
    async issueExists(key) {
      return issues.has(key);
    },
    async moveIssueToCategory(key, category) {
      writes.push(`move:${category}`);
      issues.get(key)!.category = category;
    },
  };
  return { deps, repos, pages, issues, writes };
}

const input = { spaceKey: 'DOCS', projectKey: 'CHG', actor: 'admin' };

describe('duplicate page title', () => {
  it('retries once with a unique title and finishes loading', async () => {
    const { deps, pages } = makeDeps();
    const create = deps.createPage;
    const titles: string[] = [];
    let first = true;
    deps.createPage = async (space, title, xhtml) => {
      titles.push(title);
      if (first) {
        first = false;
        throw new PageTitleConflictError();
      }
      return create(space, title, xhtml);
    };
    const r = await loadSampleData(deps, input);
    expect(r.status).toBe('LOADED');
    expect(titles).toHaveLength(2);
    expect(titles[1]).toMatch(/^SOP-PAY-014 .* \(2026-01-01 00:00 UTC\)$/);
    const page = pages.get(r.state.pageId)!;
    expect(page.title).toBe(titles[1]);
    expect(page.bodies).toHaveLength(3);
  });

  it('does not retry other failures, and gives up after one retry', async () => {
    const { deps } = makeDeps();
    let calls = 0;
    deps.createPage = async () => {
      calls++;
      throw new Error('boom');
    };
    await expect(loadSampleData(deps, input)).rejects.toThrow('boom');
    expect(calls).toBe(1);
    calls = 0;
    deps.createPage = async () => {
      calls++;
      throw new PageTitleConflictError();
    };
    await expect(loadSampleData(deps, input)).rejects.toBeInstanceOf(PageTitleConflictError);
    expect(calls).toBe(2);
  });

  it('recognises the Confluence duplicate-title response only for HTTP 400', () => {
    expect(isTitleConflict(400, '{"errors":[{"title":"A page with this title already exists: A page already exists in the space with the same title."}]}')).toBe(true);
    expect(isTitleConflict(500, 'already exists')).toBe(false);
    expect(isTitleConflict(400, 'bad body')).toBe(false);
  });
});

describe('loadSampleData', () => {
  it('creates page versions 1..3 with the expected bodies', async () => {
    const { deps, pages } = makeDeps();
    const r = await loadSampleData(deps, input);
    expect(r.status).toBe('LOADED');
    const bodies = pages.get(r.state.pageId)!.bodies;
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toContain('Initial draft.');
    expect(bodies[1]).toBe(SAMPLE_V2_XHTML);
    expect(bodies[2]).toBe(SAMPLE_V3_XHTML);
  });

  it('approves v2 and v3 as sample:priya-nair', async () => {
    const { deps, repos } = makeDeps();
    const r = await loadSampleData(deps, input);
    const proc = await repos.procedures.get(r.state.pageId);
    expect(proc?.controlled).toBe(true);
    expect(proc?.policy).toBe('approved-only');
    expect(proc?.approved.map((a) => [a.version, a.approvedBy])).toEqual([
      [2, 'sample:priya-nair'],
      [3, 'sample:priya-nair'],
    ]);
    expect(proc?.currentApproved).toBe(3);
  });

  it('creates issues and binds them: done v2 closed, hero/second v3 CURRENT', async () => {
    const { deps, repos, issues } = makeDeps();
    const r = await loadSampleData(deps, input);
    const { done, hero, second, todo } = r.state.issues;
    expect(issues.get(done)?.summary).toBe(SAMPLE_SUMMARIES.done);
    expect(issues.get(done)?.category).toBe('done');
    expect(issues.get(hero)?.category).toBe('indeterminate');
    expect(issues.get(second)?.category).toBe('indeterminate');
    expect(issues.get(todo)?.category).toBe('new');
    const pid = r.state.pageId;
    const bd = await repos.bindings.get(`${done}.${pid}`);
    expect(bd).toMatchObject({ boundVersion: 2, state: 'CURRENT' });
    expect(bd?.closedAt).toBeDefined();
    for (const k of [hero, second]) {
      const b = await repos.bindings.get(`${k}.${pid}`);
      expect(b).toMatchObject({ boundVersion: 3, state: 'CURRENT' });
      expect(b?.closedAt).toBeUndefined();
    }
    expect(await repos.bindings.get(`${todo}.${pid}`)).toBeNull();
  });

  it('sets the autoBind mapping, keeping other keys, and audits SAMPLE_LOADED on hero', async () => {
    const { deps, repos } = makeDeps();
    await repos.settings.put({ ...(await repos.settings.get()), autoBind: { 'OTHER/Bug': 'x1' } });
    const r = await loadSampleData(deps, input);
    expect((await repos.settings.get()).autoBind).toEqual({ 'OTHER/Bug': 'x1', 'CHG/Task': r.state.pageId });
    const events = await repos.audit.list(r.state.issues.hero);
    expect(events.map((e) => e.type)).toContain('SAMPLE_LOADED');
    expect(await repos.sample.get()).toEqual(r.state);
  });

  it('never overwrites an existing autoBind mapping for the same project/type', async () => {
    const { deps, repos } = makeDeps();
    await repos.settings.put({ ...(await repos.settings.get()), autoBind: { 'CHG/Task': 'admin-page' } });
    await loadSampleData(deps, input);
    expect((await repos.settings.get()).autoBind).toEqual({ 'CHG/Task': 'admin-page' });
  });

  it('is idempotent: rerun returns ALREADY_LOADED with no new writes', async () => {
    const { deps, writes } = makeDeps();
    const first = await loadSampleData(deps, input);
    const n = writes.length;
    const again = await loadSampleData(deps, input);
    expect(again.status).toBe('ALREADY_LOADED');
    expect(again.state).toEqual(first.state);
    expect(writes).toHaveLength(n);
  });

  it('recreates a missing issue on rerun without touching the page', async () => {
    const { deps, repos, issues, pages, writes } = makeDeps();
    const first = await loadSampleData(deps, input);
    issues.delete(first.state.issues.hero);
    writes.length = 0;
    const r = await loadSampleData(deps, input);
    expect(r.status).toBe('LOADED');
    expect(r.state.pageId).toBe(first.state.pageId);
    expect(r.state.issues.hero).not.toBe(first.state.issues.hero);
    expect(r.state.issues.done).toBe(first.state.issues.done);
    expect(writes).toEqual(['createIssue', 'move:indeterminate']);
    expect(pages.get(r.state.pageId)!.bodies).toHaveLength(3);
    const b = await repos.bindings.get(`${r.state.issues.hero}.${r.state.pageId}`);
    expect(b).toMatchObject({ boundVersion: 3, state: 'CURRENT' });
  });

  it('throws a clear error for a missing space', async () => {
    const { deps, writes } = makeDeps();
    await expect(loadSampleData(deps, { ...input, spaceKey: 'NOPE' })).rejects.toThrow(/space "NOPE" was not found/);
    expect(writes).toEqual([]);
  });
});

describe('publishSampleV4', () => {
  it('makes version 4 unapproved; hero is superseded only after a human approves', async () => {
    const { deps, repos, pages } = makeDeps();
    const { state } = await loadSampleData(deps, input);
    const r = await publishSampleV4(deps, { actor: 'admin' });
    expect(r).toEqual({ status: 'PUBLISHED', version: 4 });
    expect(pages.get(state.pageId)!.bodies[3]).toBe(SAMPLE_V4_XHTML);
    expect((await repos.sample.get())?.v4PublishedAt).toBeDefined();
    expect((await repos.procedures.get(state.pageId))?.currentApproved).toBe(3);
    const heroId = `${state.issues.hero}.${state.pageId}`;
    expect((await repos.bindings.get(heroId))?.state).toBe('CURRENT');

    await approveVersion(repos, deps.fetchBody, await deps.getPageMeta(state.pageId), {
      version: 4,
      actor: 'human-approver',
      at: deps.now(),
    });
    expect((await repos.bindings.get(heroId))?.state).toBe('SUPERSEDED');
    expect((await repos.bindings.get(`${state.issues.done}.${state.pageId}`))?.state).toBe('CURRENT');
  });

  it('publishing twice returns ALREADY_PUBLISHED and writes nothing', async () => {
    const { deps, pages, writes } = makeDeps();
    const { state } = await loadSampleData(deps, input);
    await publishSampleV4(deps, { actor: 'admin' });
    const n = writes.length;
    expect(await publishSampleV4(deps, { actor: 'admin' })).toEqual({ status: 'ALREADY_PUBLISHED', version: 4 });
    expect(writes).toHaveLength(n);
    expect(pages.get(state.pageId)!.bodies).toHaveLength(4);
  });

  it('requires loaded sample data', async () => {
    const { deps } = makeDeps();
    await expect(publishSampleV4(deps, { actor: 'admin' })).rejects.toThrow(/not loaded/);
  });
});

describe('resetSampleData', () => {
  async function loaded() {
    const ctx = makeDeps();
    const first = await loadSampleData(ctx.deps, input);
    await publishSampleV4(ctx.deps, { actor: 'admin' });
    await approveVersion(ctx.repos, ctx.deps.fetchBody, await ctx.deps.getPageMeta(first.state.pageId), {
      version: 4,
      actor: 'human-approver',
      at: ctx.deps.now(),
    });
    return { ...ctx, first: (await ctx.repos.sample.get())! };
  }

  it('creates a fresh v1..v3 page with the new hero CURRENT at v3', async () => {
    const { deps, repos, pages, first } = await loaded();
    const r = await resetSampleData(deps, { actor: 'admin' });
    expect(r.status).toBe('RESET');
    expect(r.previous).toEqual(first);
    expect(r.state.pageId).not.toBe(first.pageId);
    expect(pages.get(r.state.pageId)!.bodies).toHaveLength(3);
    expect(await repos.bindings.get(`${r.state.issues.hero}.${r.state.pageId}`)).toMatchObject({
      boundVersion: 3,
      state: 'CURRENT',
    });
    expect(await repos.sample.get()).toEqual(r.state);
  });

  it('audits SAMPLE_RESET before closing the old hero binding', async () => {
    const { deps, repos, first } = await loaded();
    await resetSampleData(deps, { actor: 'admin' });
    const events = await repos.audit.list(first.issues.hero);
    const ev = events.find((e) => e.type === 'SAMPLE_RESET')!;
    expect(ev.payload).toEqual({ pageId: first.pageId, bindingId: `${first.issues.hero}.${first.pageId}` });
    const b = await repos.bindings.get(`${first.issues.hero}.${first.pageId}`);
    expect(b?.closedAt).toBeDefined();
    expect(ev.at < b!.closedAt!).toBe(true);
  });

  it('renames the old page and uncontrols the old procedure', async () => {
    const { deps, repos, pages, first } = await loaded();
    await resetSampleData(deps, { actor: 'admin' });
    expect(pages.get(first.pageId)!.title).toContain('(replaced 2026-01-01 00:');
    expect((await repos.procedures.get(first.pageId))?.controlled).toBe(false);
  });

  it('moves the autoBind mapping to the new page when it pointed at the old one', async () => {
    const { deps, repos } = await loaded();
    const r = await resetSampleData(deps, { actor: 'admin' });
    expect((await repos.settings.get()).autoBind['CHG/Task']).toBe(r.state.pageId);
  });

  it('keeps an autoBind mapping that points at another page', async () => {
    const { deps, repos } = await loaded();
    await repos.settings.put({ ...(await repos.settings.get()), autoBind: { 'CHG/Task': 'admin-page' } });
    await resetSampleData(deps, { actor: 'admin' });
    expect((await repos.settings.get()).autoBind['CHG/Task']).toBe('admin-page');
  });

  it('throws NOT_LOADED without sample state', async () => {
    const { deps } = makeDeps();
    await expect(resetSampleData(deps, { actor: 'admin' })).rejects.toMatchObject({ code: 'NOT_LOADED' });
  });

  it('leaves the binding open when the audit append fails', async () => {
    const { deps, repos, first } = await loaded();
    const append = repos.audit.append.bind(repos.audit);
    repos.audit.append = async (e) => {
      if (e.type === 'SAMPLE_RESET') throw new Error('audit down');
      return append(e);
    };
    await expect(resetSampleData(deps, { actor: 'admin' })).rejects.toThrow('audit down');
    const b = await repos.bindings.get(`${first.issues.hero}.${first.pageId}`);
    expect(b?.closedAt).toBeUndefined();
    expect(await repos.sample.get()).toEqual(first);
  });
});
