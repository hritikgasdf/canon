import { describe, expect, it } from 'vitest';
import { verifyChain } from '../src/domain/audit';
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
    expect(b?.override).toEqual({ by: 'admin', at: base.at, reason: REASON, forVersion: 4 });
    const events = await repos.audit.list('CHG-1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('BREAK_GLASS');
    expect(events[0].payload).toEqual({ bindingId: 'b1', reason: REASON, forVersion: 4, priorState: 'SUPERSEDED' });
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
