import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PageMeta } from '../src/domain/approve';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import { reconcile, type ReconcileDeps } from '../src/domain/reconcile';
import type { Binding, BindingState, Procedure } from '../src/domain/types';

const PAGE = '12345';
const NOW = '2026-11-21T00:00:00.000Z';
const LATER = '2026-11-21T01:00:00.000Z';

const BODIES: Record<number, string> = {
  3: readFileSync(new URL('../seed/sop-pay-014/v3.xhtml', import.meta.url), 'utf8'),
  4: readFileSync(new URL('../seed/sop-pay-014/v4.xhtml', import.meta.url), 'utf8'),
};

function procedure(pageId = PAGE, overrides: Partial<Procedure> = {}): Procedure {
  return {
    pageId,
    title: 'SOP-PAY-014',
    controlled: true,
    policy: 'approved-only',
    approved: [{ version: 3, approvedBy: 'bob', approvedAt: NOW, bodyHash: 'h3', minorEdit: false }],
    currentApproved: 3,
    lastSeenVersion: 3,
    ...overrides,
  };
}

function binding(id: string, issueKey: string, pageId = PAGE, state: BindingState = 'CURRENT'): Binding {
  return { id, issueKey, pageId, boundVersion: 3, boundAt: NOW, boundBy: 'alice', state };
}

function deps(metas: Record<string, PageMeta | Error>): ReconcileDeps & { calls: string[] } {
  const d = {
    calls: [] as string[],
    async getPageMeta(pageId: string): Promise<PageMeta> {
      d.calls.push(pageId);
      const m = metas[pageId];
      if (!m) throw new Error('Confluence getPage failed: 404');
      if (m instanceof Error) throw m;
      return m;
    },
    async fetchBody(_pageId: string, version: number) {
      const b = BODIES[version];
      if (b === undefined) throw new Error(`no fixture for v${version}`);
      return b;
    },
    now: () => LATER,
  };
  return d;
}

const meta = (currentVersion: number, pageId = PAGE): PageMeta => ({
  pageId,
  title: 'SOP-PAY-014',
  currentVersion,
  lastEditorId: 'alice',
  minorEdit: false,
});

describe('reconcile', () => {
  it('reports UNCHANGED when the page version was already seen, and stamps lastCheckedAt', async () => {
    const repos = createMemoryRepos();
    await repos.procedures.put(procedure());
    await repos.bindings.put(binding('b1', 'PAY-1'));
    const out = await reconcile(repos, deps({ [PAGE]: meta(3) }));
    expect(out.checked).toBe(1);
    expect(out.results).toEqual([{ pageId: PAGE, action: 'UNCHANGED' }]);
    expect((await repos.procedures.get(PAGE))?.lastCheckedAt).toBe(LATER);
  });

  it('every-major: newer version auto-approves and supersedes the bound binding', async () => {
    const repos = createMemoryRepos();
    await repos.procedures.put(procedure(PAGE, { policy: 'every-major' }));
    await repos.bindings.put(binding('b1', 'PAY-1'));
    const out = await reconcile(repos, deps({ [PAGE]: meta(4) }));
    expect(out.results[0]?.action).toBe('AUTO_APPROVED');
    expect((await repos.bindings.get('b1'))?.state).toBe('SUPERSEDED');
    const p = await repos.procedures.get(PAGE);
    expect(p?.currentApproved).toBe(4);
    expect(p?.lastSeenVersion).toBe(4);
    expect(p?.lastCheckedAt).toBe(LATER);
  });

  it('approved-only: newer version is only recorded as a draft', async () => {
    const repos = createMemoryRepos();
    await repos.procedures.put(procedure());
    await repos.bindings.put(binding('b1', 'PAY-1'));
    const out = await reconcile(repos, deps({ [PAGE]: meta(4) }));
    expect(out.results[0]?.action).toBe('DRAFT_SEEN');
    const p = await repos.procedures.get(PAGE);
    expect(p?.lastSeenVersion).toBe(4);
    expect(p?.currentApproved).toBe(3);
    expect((await repos.bindings.get('b1'))?.state).toBe('CURRENT');
  });

  it('404 orphans open bindings', async () => {
    const repos = createMemoryRepos();
    await repos.procedures.put(procedure());
    await repos.bindings.put(binding('b1', 'PAY-1'));
    const out = await reconcile(repos, deps({ [PAGE]: new Error('Confluence getPage failed: 404') }));
    expect(out.results[0]?.action).toBe('ORPHANED');
    expect((await repos.bindings.get('b1'))?.state).toBe('ORPHANED');
    expect((await repos.procedures.get(PAGE))?.orphaned).toBe(true);
  });

  it('410 also orphans', async () => {
    const repos = createMemoryRepos();
    await repos.bindings.put(binding('b1', 'PAY-1'));
    const out = await reconcile(repos, deps({ [PAGE]: new Error('Confluence getPage failed: 410') }));
    expect(out.results[0]?.action).toBe('ORPHANED');
    expect((await repos.bindings.get('b1'))?.state).toBe('ORPHANED');
  });

  it('other errors are recorded as ERROR and the next page is still processed', async () => {
    const repos = createMemoryRepos();
    await repos.procedures.put(procedure('p1'));
    await repos.procedures.put(procedure('p2'));
    await repos.bindings.put(binding('b1', 'PAY-1', 'p1'));
    await repos.bindings.put(binding('b2', 'PAY-2', 'p2'));
    const out = await reconcile(
      repos,
      deps({ p1: new Error('Confluence getPage failed: 500'), p2: meta(3, 'p2') }),
    );
    expect(out.checked).toBe(2);
    expect(out.results.map((r) => [r.pageId, r.action])).toEqual([
      ['p1', 'ERROR'],
      ['p2', 'UNCHANGED'],
    ]);
    expect((await repos.bindings.get('b1'))?.state).toBe('CURRENT');
  });

  it('respects maxPages', async () => {
    const repos = createMemoryRepos();
    const metas: Record<string, PageMeta> = {};
    for (const id of ['p1', 'p2', 'p3']) {
      await repos.procedures.put(procedure(id));
      await repos.bindings.put(binding(`b-${id}`, `PAY-${id}`, id));
      metas[id] = meta(3, id);
    }
    const d = deps(metas);
    const out = await reconcile(repos, d, { maxPages: 2 });
    expect(out.checked).toBe(2);
    expect(d.calls).toHaveLength(2);
  });

  it('is idempotent: a second run reports UNCHANGED', async () => {
    const repos = createMemoryRepos();
    await repos.procedures.put(procedure(PAGE, { policy: 'every-major' }));
    await repos.bindings.put(binding('b1', 'PAY-1'));
    const d = deps({ [PAGE]: meta(4) });
    expect((await reconcile(repos, d)).results[0]?.action).toBe('AUTO_APPROVED');
    expect((await reconcile(repos, d)).results[0]?.action).toBe('UNCHANGED');
  });
});
