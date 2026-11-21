import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PageMeta } from '../src/domain/approve';
import { runCanonGate, type GateRunDeps } from '../src/domain/gateRun';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import type { Repos } from '../src/domain/repos';
import { DEFAULT_SETTINGS } from '../src/domain/types';
import type { Binding, Procedure } from '../src/domain/types';

const PAGE = '12345';
const NOW = '2026-11-21T00:00:00.000Z';
const BODIES: Record<number, string> = {
  3: readFileSync(new URL('../seed/sop-pay-014/v3.xhtml', import.meta.url), 'utf8'),
  4: readFileSync(new URL('../seed/sop-pay-014/v4.xhtml', import.meta.url), 'utf8'),
};

function procedure(pageId = PAGE, o: Partial<Procedure> = {}): Procedure {
  return {
    pageId,
    title: 'SOP-PAY-014',
    controlled: true,
    policy: 'approved-only',
    approved: [{ version: 3, approvedBy: 'bob', approvedAt: NOW, bodyHash: 'h3', minorEdit: false }],
    currentApproved: 3,
    lastSeenVersion: 3,
    ...o,
  };
}

function binding(id: string, pageId = PAGE, issueKey = 'PAY-1'): Binding {
  return { id, issueKey, pageId, boundVersion: 3, boundAt: NOW, boundBy: 'alice', state: 'CURRENT' };
}

const meta = (currentVersion: number, pageId = PAGE): PageMeta => ({
  pageId,
  title: 'SOP-PAY-014',
  currentVersion,
  lastEditorId: 'alice',
  minorEdit: false,
});

function setup(metas: Record<string, PageMeta | Error>): { repos: Repos; deps: GateRunDeps } {
  const repos = createMemoryRepos();
  return {
    repos,
    deps: {
      repos,
      async getPageMeta(pageId) {
        const m = metas[pageId];
        if (!m) throw new Error('Confluence getPage failed: 404');
        if (m instanceof Error) throw m;
        return m;
      },
      async fetchBody(_p, v) {
        const b = BODIES[v];
        if (b === undefined) throw new Error(`no fixture for v${v}`);
        return b;
      },
      now: () => NOW,
    },
  };
}

describe('runCanonGate', () => {
  it('allows with no bindings', async () => {
    const { deps } = setup({});
    const d = await runCanonGate('PAY-1', deps);
    expect(d).toMatchObject({ allow: true, bindingCount: 0 });
  });

  it('allows when the bound version is current', async () => {
    const { repos, deps } = setup({ [PAGE]: meta(3) });
    await repos.procedures.put(procedure());
    await repos.bindings.put(binding('b1'));
    expect(await runCanonGate('PAY-1', deps)).toMatchObject({ allow: true, bindingCount: 1, reasons: [] });
  });

  it('approved-only: an unapproved newer draft does not block', async () => {
    const { repos, deps } = setup({ [PAGE]: meta(4) });
    await repos.procedures.put(procedure());
    await repos.bindings.put(binding('b1'));
    const d = await runCanonGate('PAY-1', deps);
    expect(d.allow).toBe(true);
    expect((await repos.procedures.get(PAGE))?.lastSeenVersion).toBe(4);
  });

  it('every-major: newer live version blocks via inline supersede', async () => {
    const { repos, deps } = setup({ [PAGE]: meta(4) });
    await repos.procedures.put(procedure(PAGE, { policy: 'every-major' }));
    await repos.bindings.put(binding('b1'));
    const d = await runCanonGate('PAY-1', deps);
    expect(d.allow).toBe(false);
    expect(d.reasons[0]).toMatchObject({ code: 'SUPERSEDED', targetVersion: 4 });
    expect((await repos.bindings.get('b1'))?.state).toBe('SUPERSEDED');
  });

  it('approved-only: a newer approval blocks with the SUPERSEDED message', async () => {
    const { repos, deps } = setup({ [PAGE]: meta(4) });
    await repos.procedures.put(procedure(PAGE, { currentApproved: 4, lastSeenVersion: 4 }));
    await repos.bindings.put(binding('b1'));
    const d = await runCanonGate('PAY-1', deps);
    expect(d.allow).toBe(false);
    expect(d.message).toContain('v3 → v4');
  });

  it('allows when a sealed attestation exists for the target version', async () => {
    const { repos, deps } = setup({ [PAGE]: meta(4) });
    await repos.procedures.put(procedure(PAGE, { policy: 'every-major', currentApproved: 4, lastSeenVersion: 4 }));
    await repos.bindings.put({ ...binding('b1'), state: 'REATTESTING', supersededBy: 4 });
    await repos.attestations.put({
      bindingId: 'b1',
      toVersion: 4,
      items: [{ itemId: 'i1', status: 'DONE' }],
      implementer: 'alice',
      checker: 'bob',
      checkerSignedAt: NOW,
      sealHash: 'seal',
    });
    expect(await runCanonGate('PAY-1', deps)).toMatchObject({ allow: true, reasons: [] });
  });

  it('inline supersede is idempotent across repeated runs', async () => {
    const { repos, deps } = setup({ [PAGE]: meta(4) });
    await repos.procedures.put(procedure(PAGE, { policy: 'every-major' }));
    await repos.bindings.put(binding('b1'));
    const first = await runCanonGate('PAY-1', deps);
    const snap = async (): Promise<string> =>
      JSON.stringify([
        await repos.bindings.get('b1'),
        await repos.procedures.get(PAGE),
        await repos.audit.list('PAY-1'),
      ]);
    const afterFirst = await snap();
    const second = await runCanonGate('PAY-1', deps);
    expect(await snap()).toBe(afterFirst);
    expect(second).toEqual(first);
    const events = await repos.audit.list('PAY-1');
    expect(events.filter((e) => e.type === 'SUPERSEDED')).toHaveLength(1);
  });

  it('binding without a procedure is UNVERIFIED and blocks', async () => {
    const { repos, deps } = setup({ [PAGE]: meta(3) });
    await repos.bindings.put(binding('b1'));
    const d = await runCanonGate('PAY-1', deps);
    expect(d.allow).toBe(false);
    expect(d.reasons[0]?.code).toBe('UNVERIFIED');
  });

  it('404 makes the gate block with ORPHANED (gate does not persist; reconcile does)', async () => {
    const { repos, deps } = setup({ [PAGE]: new Error('Confluence getPage failed: 404') });
    await repos.procedures.put(procedure());
    await repos.bindings.put(binding('b1'));
    const d = await runCanonGate('PAY-1', deps);
    expect(d.allow).toBe(false);
    expect(d.reasons[0]?.code).toBe('ORPHANED');
  });

  it('rejects on a non-404 error so the caller fails closed', async () => {
    const { repos, deps } = setup({ [PAGE]: new Error('Confluence getPage failed: 500') });
    await repos.procedures.put(procedure());
    await repos.bindings.put(binding('b1'));
    await expect(runCanonGate('PAY-1', deps)).rejects.toThrow('500');
  });

  it('warn mode allows with warnOnly and keeps reasons', async () => {
    const { repos, deps } = setup({ [PAGE]: meta(4) });
    await repos.settings.put({ ...DEFAULT_SETTINGS, validatorMode: 'warn' });
    await repos.procedures.put(procedure(PAGE, { policy: 'every-major' }));
    await repos.bindings.put(binding('b1'));
    const d = await runCanonGate('PAY-1', deps);
    expect(d).toMatchObject({ allow: true, warnOnly: true });
    expect(d.reasons).toHaveLength(1);
  });

  it('two bindings, one superseded -> blocks', async () => {
    const { repos, deps } = setup({ p1: meta(3, 'p1'), p2: meta(4, 'p2') });
    await repos.procedures.put(procedure('p1'));
    await repos.procedures.put(procedure('p2', { policy: 'every-major' }));
    await repos.bindings.put(binding('b1', 'p1'));
    await repos.bindings.put(binding('b2', 'p2'));
    const d = await runCanonGate('PAY-1', deps);
    expect(d).toMatchObject({ allow: false, bindingCount: 2 });
    expect(d.reasons.map((r) => r.pageId)).toEqual(['p2']);
  });
});
