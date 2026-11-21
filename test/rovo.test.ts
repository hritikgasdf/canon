import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PageMeta } from '../src/domain/approve';
import { GATE_FAIL_CLOSED } from '../src/domain/gateEval';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import {
  rovoApprovedProcedure,
  rovoAssignChecker,
  rovoCreateChecklist,
  rovoExplainDelta,
  rovoGateStatus,
  type RovoDeps,
  type RovoWriteDeps,
} from '../src/domain/rovo';
import { snapshotFromXhtml } from '../src/domain/parse';
import type { Binding, Procedure, StepNode } from '../src/domain/types';

const PAGE = '12345';
const NOW = '2026-11-21T00:00:00.000Z';
const BODIES: Record<number, string> = {
  3: readFileSync(new URL('../seed/sop-pay-014/v3.xhtml', import.meta.url), 'utf8'),
  4: readFileSync(new URL('../seed/sop-pay-014/v4.xhtml', import.meta.url), 'utf8'),
};

const approved = (version: number) => ({ version, approvedBy: 'bob', approvedAt: NOW, bodyHash: `h${version}`, minorEdit: false });

function procedure(o: Partial<Procedure> = {}): Procedure {
  return {
    pageId: PAGE,
    title: 'SOP-PAY-014',
    controlled: true,
    policy: 'approved-only',
    approved: [approved(3)],
    currentApproved: 3,
    lastSeenVersion: 3,
    ...o,
  };
}

function binding(o: Partial<Binding> = {}): Binding {
  return { id: 'b1', issueKey: 'PAY-1', pageId: PAGE, boundVersion: 3, boundAt: NOW, boundBy: 'alice', state: 'CURRENT', ...o };
}

function setup(live: number | Error, canView = true) {
  const repos = createMemoryRepos();
  const fetched: number[] = [];
  const deps: RovoDeps = {
    repos,
    async getPageMeta(pageId): Promise<PageMeta> {
      if (live instanceof Error) throw live;
      return { pageId, title: 'SOP-PAY-014', currentVersion: live, lastEditorId: 'alice', minorEdit: false };
    },
    async fetchBody(_p, v) {
      fetched.push(v);
      const b = BODIES[v];
      if (b === undefined) throw new Error(`no fixture for v${v}`);
      return b;
    },
    canView: async () => canView,
    now: () => NOW,
  };
  return { repos, deps, fetched };
}

async function superseded(canView = true) {
  const s = setup(4, canView);
  await s.repos.procedures.put(procedure({ approved: [approved(3), approved(4)], currentApproved: 4, lastSeenVersion: 4 }));
  await s.repos.bindings.put(binding({ state: 'SUPERSEDED', supersededBy: 4 }));
  return s;
}

describe('rovoGateStatus closed binding', () => {
  it('reports state CLOSED for a binding with closedAt', async () => {
    const { repos, deps } = setup(3);
    await repos.procedures.put(procedure());
    await repos.bindings.put(binding({ closedAt: NOW }));
    const r = await rovoGateStatus('PAY-1', deps);
    expect(r.bindings?.[0]).toMatchObject({ bindingId: 'b1', state: 'CLOSED', boundVersion: 3 });
    expect(r.overall).toBe('CLOSED');
  });

  it('overall CLOSED (not BLOCKED) when done work is behind a newer approved version', async () => {
    const { repos, deps } = setup(4);
    await repos.procedures.put(procedure({ approved: [approved(3), approved(4)], currentApproved: 4, lastSeenVersion: 4 }));
    await repos.bindings.put(binding({ closedAt: NOW }));
    const r = await rovoGateStatus('PAY-1', deps);
    expect(r.overall).toBe('CLOSED');
  });

  it('not CLOSED when one of two bindings is still open', async () => {
    const { repos, deps } = setup(4);
    await repos.procedures.put(procedure({ approved: [approved(3), approved(4)], currentApproved: 4, lastSeenVersion: 4 }));
    await repos.bindings.put(binding({ closedAt: NOW }));
    await repos.bindings.put(binding({ id: 'b2', pageId: 'P2' }));
    const r = await rovoGateStatus('PAY-1', deps);
    expect(r.overall).not.toBe('CLOSED');
  });
});

describe('rovoGateStatus', () => {
  it('NO_BINDING when nothing is bound', async () => {
    const { deps } = setup(3);
    expect(await rovoGateStatus('PAY-1', deps)).toMatchObject({ ok: true, overall: 'NO_BINDING' });
  });

  it('CLEAR when bound to the current version', async () => {
    const { repos, deps } = setup(3);
    await repos.procedures.put(procedure());
    await repos.bindings.put(binding());
    const r = await rovoGateStatus('PAY-1', deps);
    expect(r).toMatchObject({ overall: 'CLEAR' });
    expect(r.bindings?.[0]).toMatchObject({ bindingId: 'b1', state: 'CURRENT', title: 'SOP-PAY-014', restricted: false });
  });

  it('BLOCKED with the superseded target version', async () => {
    const { deps } = await superseded();
    const r = await rovoGateStatus('PAY-1', deps);
    expect(r.overall).toBe('BLOCKED');
    expect(r.bindings?.[0]).toMatchObject({ state: 'SUPERSEDED', boundVersion: 3, targetVersion: 4 });
  });

  it('a restricted binding hides the title and target', async () => {
    const { deps } = await superseded(false);
    const r = await rovoGateStatus('PAY-1', deps);
    expect(r.overall).toBe('BLOCKED');
    expect(r.bindings?.[0]).toEqual({ bindingId: 'b1', state: 'SUPERSEDED', boundVersion: 3, restricted: true });
  });

  it('UNVERIFIED when the gate throws', async () => {
    const { repos, deps } = setup(new Error('Confluence getPage failed: 500'));
    await repos.procedures.put(procedure());
    await repos.bindings.put(binding());
    expect(await rovoGateStatus('PAY-1', deps)).toEqual({
      ok: true,
      issueKey: 'PAY-1',
      overall: 'UNVERIFIED',
      message: GATE_FAIL_CLOSED,
    });
  });
});

describe('rovoExplainDelta', () => {
  it('lists delta items with before/after text', async () => {
    const { deps } = await superseded();
    const r = await rovoExplainDelta('PAY-1', deps);
    const b = r.bindings[0];
    expect(b).toMatchObject({ restricted: false, fromVersion: 3, toVersion: 4 });
    if (b?.restricted !== false) throw new Error('expected visible binding');
    expect(b.items.length).toBeGreaterThan(0);
    expect(b.items[0]).toHaveProperty('hints');
    expect(b.items[0]).toHaveProperty('trivial');
    expect(Object.values(b.counts).reduce((a, c) => a + c, 0)).toBe(b.items.length);
  });

  it('a restricted binding shows no delta', async () => {
    const { deps, fetched } = await superseded(false);
    const r = await rovoExplainDelta('PAY-1', deps);
    expect(r.bindings).toEqual([{ bindingId: 'b1', restricted: true }]);
    expect(fetched).toEqual([]);
  });
});

describe('rovoApprovedProcedure', () => {
  it('returns approved text only and never fetches draft text', async () => {
    const s = setup(4);
    await s.repos.procedures.put(procedure({ lastSeenVersion: 4 })); // v4 is a pending draft
    await s.repos.bindings.put(binding());
    const r = await rovoApprovedProcedure('PAY-1', undefined, s.deps);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) throw new Error('unexpected');
    const b = r.bindings[0];
    if (b?.restricted !== false) throw new Error('expected visible binding');
    expect(b.version).toBe(3);
    expect(b.nodes.length).toBeGreaterThan(0);
    expect(s.fetched.every((v) => v === 3)).toBe(true);
    const texts = (ns: StepNode[]): string[] => ns.flatMap((n) => [n.text, ...texts(n.children ?? [])]);
    const draftOnly = texts(snapshotFromXhtml(PAGE, 4, BODIES[4] ?? '').nodes).map((text) => ({ text }));
    const v3Text = new Set(b.nodes.map((n) => n.text));
    const onlyIn4 = draftOnly.map((n) => n.text).filter((t) => !v3Text.has(t));
    expect(onlyIn4.length).toBeGreaterThan(0);
    for (const t of onlyIn4) expect(JSON.stringify(r)).not.toContain(t);
  });

  it('refuses a superseded requested version', async () => {
    const { deps } = await superseded();
    const r = await rovoApprovedProcedure('PAY-1', 3, deps);
    expect(r).toMatchObject({ ok: false, error: 'NOT_APPROVED_VERSION' });
    expect(r.ok ? '' : r.message).toContain('superseded');
  });

  it('refuses a requested draft version', async () => {
    const s = setup(4);
    await s.repos.procedures.put(procedure({ lastSeenVersion: 4 }));
    await s.repos.bindings.put(binding());
    const r = await rovoApprovedProcedure('PAY-1', 4, s.deps);
    expect(r).toMatchObject({ ok: false, error: 'NOT_APPROVED_VERSION' });
    expect(r.ok ? '' : r.message).toContain('draft');
    expect(s.fetched).toEqual([]);
  });

  it('a restricted binding hides the procedure text', async () => {
    const { deps } = await superseded(false);
    const r = await rovoApprovedProcedure('PAY-1', undefined, deps);
    expect(r).toMatchObject({ ok: true, bindings: [{ bindingId: 'b1', restricted: true }] });
    expect(JSON.stringify(r)).not.toContain('SOP-PAY-014');
  });
});

describe('write-side actions', () => {
  const CHECKER = 'checker-account-1';
  async function setupW(opts: { canView?: boolean; browse?: boolean } = {}) {
    const s = await superseded(opts.canView ?? true);
    const wdeps: RovoWriteDeps = { ...s.deps, canUserBrowseIssue: async () => opts.browse ?? true };
    const delta = await rovoExplainDelta('PAY-1', { ...s.deps, canView: async () => true });
    const b = delta.bindings[0];
    const ids = b?.restricted === false ? b.items.filter((i) => !i.trivial).map((i) => i.itemId) : [];
    return { ...s, wdeps, ids };
  }
  const create = (w: RovoWriteDeps, ids: string[], extra: { bindingId?: string } = {}, actor = 'alice') =>
    rovoCreateChecklist(
      'PAY-1',
      actor,
      { ...extra, itemIdsJson: JSON.stringify(ids.slice(0, 1)), tasksJson: JSON.stringify(['Check the limit']) },
      w,
    );
  const auditTypes = async (w: RovoWriteDeps) => (await w.repos.audit.list('PAY-1')).map((e) => e.type);

  it('creates a checklist, starts re-attestation and audits once', async () => {
    const { wdeps, ids } = await setupW();
    const r = await create(wdeps, ids);
    expect(r).toMatchObject({ ok: true, bindingId: 'b1', toVersion: 4, implementer: 'alice' });
    if (!r.ok) throw new Error('unexpected');
    expect(r.items.find((i) => i.itemId === ids[0])).toMatchObject({ status: 'PENDING', rovoTask: 'Check the limit' });
    expect((await auditTypes(wdeps)).filter((t) => t === 'ROVO_TASKS_SET')).toHaveLength(1);
  });

  it('is idempotent and writes no duplicate audit event', async () => {
    const { wdeps, ids } = await setupW();
    const a = await create(wdeps, ids);
    const before = await auditTypes(wdeps);
    const b = await create(wdeps, ids, {}, 'carol');
    expect(b).toEqual({ ...a, status: 'ALREADY_CREATED' });
    expect(await auditTypes(wdeps)).toEqual(before);
  });

  it('a rephrased second call keeps the first suggestion and writes no audit event', async () => {
    const { wdeps, ids } = await setupW();
    await create(wdeps, ids);
    const before = await auditTypes(wdeps);
    const r = await rovoCreateChecklist(
      'PAY-1',
      'alice',
      { itemIdsJson: JSON.stringify(ids.slice(0, 1)), tasksJson: JSON.stringify(['Verify the limit again, rephrased']) },
      wdeps,
    );
    expect(r).toMatchObject({ ok: true, status: 'ALREADY_CREATED' });
    if (r.ok) expect(r.items.find((i) => i.itemId === ids[0])?.rovoTask).toBe('Check the limit');
    expect(await auditTypes(wdeps)).toEqual(before);
  });

  it('a second call with a new item id sets only that item', async () => {
    const { wdeps, ids } = await setupW();
    expect(ids.length).toBeGreaterThanOrEqual(2);
    await create(wdeps, ids);
    const r = await rovoCreateChecklist(
      'PAY-1',
      'alice',
      { itemIdsJson: JSON.stringify(ids.slice(0, 2)), tasksJson: JSON.stringify(['Other text', 'Second item task']) },
      wdeps,
    );
    expect(r).toMatchObject({ ok: true, status: 'CREATED' });
    if (r.ok) {
      expect(r.items.find((i) => i.itemId === ids[0])?.rovoTask).toBe('Check the limit');
      expect(r.items.find((i) => i.itemId === ids[1])?.rovoTask).toBe('Second item task');
    }
    const events = (await wdeps.repos.audit.list('PAY-1')).filter((e) => e.type === 'ROVO_TASKS_SET');
    expect(events[events.length - 1].payload.itemIds).toEqual([ids[1]]);
  });

  it('rejects an unknown item id and writes nothing', async () => {
    const { wdeps, repos } = await setupW();
    const r = await rovoCreateChecklist('PAY-1', 'alice', { itemIdsJson: '["nope"]', tasksJson: '["x"]' }, wdeps);
    expect(r).toMatchObject({ ok: false, error: 'UNKNOWN_ITEM' });
    expect(await repos.audit.list('PAY-1')).toEqual([]);
    expect((await repos.bindings.get('b1'))?.state).toBe('SUPERSEDED');
  });

  it('rejects bad JSON and length mismatch', async () => {
    const { wdeps } = await setupW();
    expect(await rovoCreateChecklist('PAY-1', 'alice', { itemIdsJson: '{', tasksJson: '[]' }, wdeps)).toMatchObject({ error: 'BAD_INPUT' });
    expect(await rovoCreateChecklist('PAY-1', 'alice', { itemIdsJson: '["a","b"]', tasksJson: '["x"]' }, wdeps)).toMatchObject({ error: 'BAD_INPUT' });
  });

  it('accepts a tasks object keyed by item id', async () => {
    const { wdeps, ids } = await setupW();
    const r = await rovoCreateChecklist(
      'PAY-1',
      'alice',
      { itemIdsJson: JSON.stringify(ids.slice(0, 1)), tasksJson: JSON.stringify({ [ids[0] as string]: 'Do it' }) },
      wdeps,
    );
    expect(r).toMatchObject({ ok: true });
  });

  it('reports an ambiguous binding when two need re-attestation', async () => {
    const { wdeps, repos, ids } = await setupW();
    await repos.bindings.put(binding({ id: 'b2', state: 'SUPERSEDED', supersededBy: 4 }));
    expect(await create(wdeps, ids)).toMatchObject({ ok: false, error: 'AMBIGUOUS_BINDING' });
    expect(await create(wdeps, ids, { bindingId: 'b1' })).toMatchObject({ ok: true, bindingId: 'b1' });
  });

  it('a restricted binding cannot be written', async () => {
    const { wdeps } = await setupW({ canView: false });
    expect(await create(wdeps, ['x'])).toMatchObject({ ok: false, error: 'RESTRICTED' });
  });

  it('assigns a checker (happy path, audited, idempotent)', async () => {
    const { wdeps, ids, repos } = await setupW();
    await create(wdeps, ids);
    expect(await rovoAssignChecker('PAY-1', 'alice', { checkerAccountId: CHECKER }, wdeps)).toEqual({ ok: true, checker: CHECKER });
    expect((await repos.attestations.get('b1', 4))?.checker).toBe(CHECKER);
    await rovoAssignChecker('PAY-1', 'alice', { checkerAccountId: CHECKER }, wdeps);
    expect((await auditTypes(wdeps)).filter((t) => t === 'CHECKER_ASSIGNED')).toHaveLength(1);
  });

  it('rejects the implementer as checker', async () => {
    const { wdeps, ids } = await setupW();
    await create(wdeps, ids, {}, 'implementer-1');
    expect(await rovoAssignChecker('PAY-1', 'implementer-1', { checkerAccountId: 'implementer-1' }, wdeps)).toMatchObject({
      ok: false,
      error: 'SELF_REVIEW',
    });
  });

  it('rejects a checker without browse access', async () => {
    const { wdeps, ids } = await setupW({ browse: false });
    await create(wdeps, ids);
    expect(await rovoAssignChecker('PAY-1', 'alice', { checkerAccountId: CHECKER }, wdeps)).toMatchObject({
      ok: false,
      error: 'CHECKER_NO_ACCESS',
    });
  });

  it('rejects a non-implementer and a malformed account id', async () => {
    const { wdeps, ids } = await setupW();
    await create(wdeps, ids);
    expect(await rovoAssignChecker('PAY-1', 'mallory', { checkerAccountId: CHECKER }, wdeps)).toMatchObject({
      ok: false,
      error: 'NOT_IMPLEMENTER',
    });
    expect(await rovoAssignChecker('PAY-1', 'alice', { checkerAccountId: 'a b' }, wdeps)).toMatchObject({ error: 'BAD_INPUT' });
  });
});
