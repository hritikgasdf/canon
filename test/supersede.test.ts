import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { verifyChain } from '../src/domain/audit';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import type { Repos } from '../src/domain/repos';
import { ensureDelta, ensureSnapshot, supersede, type BodyFetcher } from '../src/domain/supersede';
import type { Binding } from '../src/domain/types';

const seed = (v: number): string => readFileSync(`seed/sop-pay-014/v${v}.xhtml`, 'utf8');
const V5 = seed(4).replace(
  '<li>Status page draft is prepared.</li>',
  '<li>Status page draft is prepared.</li><li>Notify the Risk duty officer of the window.</li>',
);
const bodies: Record<number, string> = { 3: seed(3), 4: seed(4), 5: V5 };
const P = 'p1';
const ctx = { pageId: P, actor: 'sys', at: '2026-01-01T00:00:00Z' };

function setup() {
  const repos = createMemoryRepos();
  const fetchBody = vi.fn<BodyFetcher>(async (_p, v) => {
    const b = bodies[v];
    if (b === undefined) throw new Error(`no body ${v}`);
    return b;
  });
  return { repos, fetchBody };
}

async function bind(repos: Repos, id: string, over: Partial<Binding> = {}): Promise<void> {
  await repos.bindings.put({
    id,
    issueKey: `CHG-${id}`,
    pageId: P,
    boundVersion: 3,
    boundAt: 't',
    boundBy: 'u',
    state: 'CURRENT',
    ...over,
  });
}

describe('supersede', () => {
  it('ensureSnapshot stores and reuses', async () => {
    const { repos, fetchBody } = setup();
    const a = await ensureSnapshot(repos, fetchBody, P, 3);
    const b = await ensureSnapshot(repos, fetchBody, P, 3);
    expect(b).toEqual(a);
    expect(fetchBody).toHaveBeenCalledTimes(1);
  });

  it('ensureDelta creates then reuses', async () => {
    const { repos, fetchBody } = setup();
    const a = await ensureDelta(repos, fetchBody, P, 3, 4);
    const b = await ensureDelta(repos, fetchBody, P, 3, 4);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.delta).toEqual(a.delta);
  });

  it('supersedes CURRENT v3 binding to v4 with audit', async () => {
    const { repos, fetchBody } = setup();
    await bind(repos, '1');
    const r = await supersede(repos, fetchBody, { ...ctx, toVersion: 4 });
    expect(r).toMatchObject({ deltaCreated: true, superseded: ['1'], skipped: [] });
    const b = await repos.bindings.get('1');
    expect(b).toMatchObject({ state: 'SUPERSEDED', supersededBy: 4, boundVersion: 3 });
    const ev = await repos.audit.list('CHG-1');
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe('SUPERSEDED');
    expect(ev[0].payload).toEqual({ bindingId: '1', pageId: P, fromVersion: 3, toVersion: 4, deltaItems: 3 });
  });

  it('is idempotent', async () => {
    const { repos, fetchBody } = setup();
    await bind(repos, '1');
    await supersede(repos, fetchBody, { ...ctx, toVersion: 4 });
    const r2 = await supersede(repos, fetchBody, { ...ctx, toVersion: 4 });
    expect(r2).toMatchObject({ deltaCreated: false, superseded: [], skipped: ['1'] });
    expect(await repos.audit.list('CHG-1')).toHaveLength(1);
  });

  it('skips closed issues', async () => {
    const { repos, fetchBody } = setup();
    await bind(repos, '1');
    const r = await supersede(repos, fetchBody, { ...ctx, toVersion: 4, isIssueOpen: async () => false });
    expect(r.skipped).toEqual(['1']);
    expect((await repos.bindings.get('1'))?.state).toBe('CURRENT');
    expect(await repos.audit.list('CHG-1')).toHaveLength(0);
    expect(fetchBody).not.toHaveBeenCalled();
  });

  it('skips binding already at target version', async () => {
    const { repos, fetchBody } = setup();
    await bind(repos, '1', { boundVersion: 4 });
    const r = await supersede(repos, fetchBody, { ...ctx, toVersion: 4 });
    expect(r.skipped).toEqual(['1']);
    expect(fetchBody).not.toHaveBeenCalled();
  });

  it('supersedes CLEARED at v4 when v5 arrives', async () => {
    const { repos, fetchBody } = setup();
    await bind(repos, '1', { state: 'CLEARED', supersededBy: 4, clearedAt: 't' });
    const r = await supersede(repos, fetchBody, { ...ctx, toVersion: 5 });
    expect(r.superseded).toEqual(['1']);
    expect(r.deltaCreated).toBe(true);
    expect(await repos.deltas.get(P, 4, 5)).not.toBeNull();
    expect(await repos.deltas.get(P, 3, 5)).toBeNull();
    expect(await repos.bindings.get('1')).toMatchObject({ state: 'SUPERSEDED', supersededBy: 5, boundVersion: 3 });
    const ev = await repos.audit.list('CHG-1');
    expect(ev[0].payload).toMatchObject({ fromVersion: 4, toVersion: 5 });
  });

  it('CLEARED at v4 is skipped for v4', async () => {
    const { repos, fetchBody } = setup();
    await bind(repos, '1', { state: 'CLEARED', supersededBy: 4 });
    const r = await supersede(repos, fetchBody, { ...ctx, toVersion: 4 });
    expect(r.skipped).toEqual(['1']);
  });

  it('two issues: delta once, each version fetched once', async () => {
    const { repos, fetchBody } = setup();
    await bind(repos, '1');
    await bind(repos, '2');
    const r = await supersede(repos, fetchBody, { ...ctx, toVersion: 4 });
    expect([...r.superseded].sort()).toEqual(['1', '2']);
    expect(fetchBody).toHaveBeenCalledTimes(2);
    expect(fetchBody.mock.calls.map((c) => c[1]).sort()).toEqual([3, 4]);
    expect(await repos.audit.list('CHG-1')).toHaveLength(1);
    expect(await repos.audit.list('CHG-2')).toHaveLength(1);
  });

  it('fetch error propagates and writes nothing', async () => {
    const { repos } = setup();
    await bind(repos, '1');
    const boom: BodyFetcher = async () => {
      throw new Error('network');
    };
    await expect(supersede(repos, boom, { ...ctx, toVersion: 4 })).rejects.toThrow('network');
    expect((await repos.bindings.get('1'))?.state).toBe('CURRENT');
    expect(await repos.audit.list('CHG-1')).toHaveLength(0);
    expect(await repos.deltas.get(P, 3, 4)).toBeNull();
  });

  it('does not touch the procedure and audit chain verifies', async () => {
    const { repos, fetchBody } = setup();
    const proc = {
      pageId: P,
      title: 't',
      controlled: true,
      policy: 'approved-only' as const,
      approved: [],
      currentApproved: 3,
      lastSeenVersion: 3,
    };
    await repos.procedures.put(proc);
    await bind(repos, '1', { state: 'CLEARED', supersededBy: 4 });
    await bind(repos, '2');
    await supersede(repos, fetchBody, { ...ctx, toVersion: 4 });
    await supersede(repos, fetchBody, { ...ctx, toVersion: 5 });
    expect(await repos.procedures.get(P)).toEqual(proc);
    for (const k of ['CHG-1', 'CHG-2']) {
      expect(verifyChain(await repos.audit.list(k)).ok).toBe(true);
    }
    expect(await repos.audit.list('CHG-2')).toHaveLength(2);
  });
});
