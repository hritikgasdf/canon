import { describe, expect, it } from 'vitest';
import { verifyChain } from '../src/domain/audit';
import { evaluateGate } from '../src/domain/gateEval';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import { breakGlass, OverrideError } from '../src/domain/override';
import type { Binding, Procedure } from '../src/domain/types';

const REASON = 'Production incident, approved by CAB';
const base = {
  issueKey: 'CHG-1',
  bindingId: 'b1',
  actor: 'admin',
  at: '2026-01-01T00:00:00Z',
  reason: REASON,
  isProjectAdmin: true,
};

async function setup(over: Partial<Binding> = {}) {
  const repos = createMemoryRepos();
  const procedure: Procedure = {
    pageId: 'p1',
    title: 'T',
    controlled: true,
    policy: 'approved-only',
    approved: [],
    currentApproved: 4,
    lastSeenVersion: 4,
  };
  await repos.procedures.put(procedure);
  await repos.bindings.put({
    id: 'b1',
    issueKey: 'CHG-1',
    pageId: 'p1',
    boundVersion: 3,
    boundAt: 't',
    boundBy: 'u',
    state: 'SUPERSEDED',
    supersededBy: 4,
    ...over,
  });
  return repos;
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof OverrideError ? e.code : 'OTHER';
  }
  return 'NONE';
};

describe('breakGlass', () => {
  it('refuses non-admins', async () => {
    expect(await code(breakGlass(await setup(), { ...base, isProjectAdmin: false }))).toBe('NOT_ADMIN');
  });
  it('refuses short and overlong reasons', async () => {
    const repos = await setup();
    expect(await code(breakGlass(repos, { ...base, reason: ' too short ' }))).toBe('REASON_REQUIRED');
    expect(await code(breakGlass(repos, { ...base, reason: 'x'.repeat(1001) }))).toBe('REASON_REQUIRED');
  });
  it('refuses a CURRENT binding', async () => {
    const repos = await setup({ state: 'CURRENT', supersededBy: undefined });
    expect(await code(breakGlass(repos, base))).toBe('NOT_BLOCKED');
  });
  it('refuses a binding on another issue', async () => {
    expect(await code(breakGlass(await setup(), { ...base, issueKey: 'CHG-2' }))).toBe('NOT_FOUND');
  });
  it('sets the override, keeps state and writes a valid audit chain', async () => {
    const repos = await setup();
    await breakGlass(repos, base);
    const b = await repos.bindings.get('b1');
    expect(b?.state).toBe('SUPERSEDED');
    expect(b?.override).toEqual({ by: 'admin', at: base.at, reason: REASON, forVersion: 4, priorState: 'SUPERSEDED' });
    const events = await repos.audit.list('CHG-1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('BREAK_GLASS');
    expect(events[0].payload).toEqual({ bindingId: 'b1', reason: REASON, forVersion: 4, priorState: 'SUPERSEDED' });
    expect(verifyChain(events).ok).toBe(true);
  });
  it('records priorState in the override', async () => {
    const b = await breakGlass(await setup(), base);
    expect(b.override?.priorState).toBe('SUPERSEDED');
  });
  it('rejects a second break-glass while the override still covers the target', async () => {
    const repos = await setup();
    await breakGlass(repos, base);
    expect(await code(breakGlass(repos, base))).toBe('ALREADY_OVERRIDDEN');
    expect(await repos.audit.list('CHG-1')).toHaveLength(1);
  });
  it('allows a new break-glass after a newer revision re-blocks', async () => {
    const repos = await setup();
    await breakGlass(repos, base);
    const proc = await repos.procedures.get('p1');
    await repos.procedures.put({ ...proc!, currentApproved: 5 });
    const b = await repos.bindings.get('b1');
    await repos.bindings.put({ ...b!, supersededBy: 5 });
    const next = await breakGlass(repos, base);
    expect(next.override?.forVersion).toBe(5);
  });
  it('audit failure leaves the binding without an override and the gate blocking', async () => {
    const repos = await setup();
    repos.audit.append = async () => {
      throw new Error('audit down');
    };
    await expect(breakGlass(repos, base)).rejects.toThrow('audit down');
    const b = await repos.bindings.get('b1');
    expect(b?.override).toBeUndefined();
    const d = evaluateGate({
      issueKey: 'CHG-1',
      mode: 'block',
      bindings: [b!],
      procedures: { p1: await repos.procedures.get('p1') },
      liveVersions: { p1: 4 },
      attestations: {},
    });
    expect(d.allow).toBe(false);
  });
  it('put failure appends BREAK_GLASS_FAILED and rethrows', async () => {
    const repos = await setup();
    repos.bindings.put = async () => {
      throw new Error('put down');
    };
    await expect(breakGlass(repos, base)).rejects.toThrow('put down');
    const events = await repos.audit.list('CHG-1');
    expect(events.map((e) => e.type)).toEqual(['BREAK_GLASS', 'BREAK_GLASS_FAILED']);
    expect(verifyChain(events).ok).toBe(true);
  });
  it('uses null forVersion for an orphan without a procedure', async () => {
    const repos = createMemoryRepos();
    await repos.bindings.put({
      id: 'b1',
      issueKey: 'CHG-1',
      pageId: 'gone',
      boundVersion: 3,
      boundAt: 't',
      boundBy: 'u',
      state: 'ORPHANED',
    });
    const b = await breakGlass(repos, base);
    expect(b.override?.forVersion).toBeNull();
  });
});
