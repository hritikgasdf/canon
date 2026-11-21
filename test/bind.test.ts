import { describe, expect, it } from 'vitest';
import { bindIssue, BindError } from '../src/domain/bind';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import type { Repos } from '../src/domain/repos';
import type { Binding, BindingState, Procedure } from '../src/domain/types';

const NOW = '2026-11-21T00:00:00.000Z';

function procedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    pageId: 'P1',
    title: 'Procedure P1',
    controlled: true,
    policy: 'approved-only',
    approved: [{ version: 3, approvedBy: 'alice', approvedAt: NOW, bodyHash: 'h3', minorEdit: false }],
    currentApproved: 3,
    lastSeenVersion: 3,
    ...overrides,
  };
}

async function seeded(procedures: Procedure[], bindings: Binding[] = []): Promise<Repos> {
  const repos = createMemoryRepos();
  for (const p of procedures) await repos.procedures.put(p);
  for (const b of bindings) await repos.bindings.put(b);
  return repos;
}

function binding(state: BindingState): Binding {
  return { id: 'OPS-1.P1', issueKey: 'OPS-1', pageId: 'P1', boundVersion: 2, boundAt: NOW, boundBy: 'bob', state };
}

const input = { issueKey: 'OPS-1', pageId: 'P1', actor: 'carol', at: NOW };

async function expectBindError(promise: Promise<unknown>, code: string): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BindError);
  expect((err as BindError).code).toBe(code);
}

describe('bindIssue', () => {
  it('binds the approved version, not a newer draft seen by reconcile', async () => {
    const repos = await seeded([procedure({ currentApproved: 3, lastSeenVersion: 7 })]);
    const b = await bindIssue(repos, input);
    expect(b.boundVersion).toBe(3);
    expect(b.id).toBe('OPS-1.P1');
    expect(b.state).toBe('CURRENT');
    expect(b.boundBy).toBe('carol');
    expect(b.boundAt).toBe(NOW);
    expect(await repos.bindings.get('OPS-1.P1')).toEqual(b);
  });

  it('rejects a procedure that is not controlled', async () => {
    const repos = await seeded([procedure({ controlled: false })]);
    await expectBindError(bindIssue(repos, input), 'NOT_CONTROLLED');
    await expectBindError(bindIssue(createMemoryRepos(), input), 'NOT_CONTROLLED');
  });

  it('rejects a controlled procedure with no approved version', async () => {
    const repos = await seeded([procedure({ approved: [], currentApproved: null, lastSeenVersion: 2 })]);
    await expectBindError(bindIssue(repos, input), 'NO_APPROVED_VERSION');
  });

  it.each(['CURRENT', 'SUPERSEDED', 'REATTESTING'] as const)('rejects a duplicate while the binding is %s', async (state) => {
    const repos = await seeded([procedure()], [binding(state)]);
    await expectBindError(bindIssue(repos, input), 'ALREADY_BOUND');
    expect((await repos.bindings.get('OPS-1.P1'))?.state).toBe(state);
  });

  it.each(['CLEARED', 'ORPHANED'] as const)('allows re-binding after the binding is %s', async (state) => {
    const repos = await seeded([procedure({ currentApproved: 4, approved: [{ version: 4, approvedBy: 'alice', approvedAt: NOW, bodyHash: 'h4', minorEdit: false }] })], [binding(state)]);
    const b = await bindIssue(repos, input);
    expect(b.state).toBe('CURRENT');
    expect(b.boundVersion).toBe(4);
  });

  it('writes a BOUND audit event with the page and version', async () => {
    const repos = await seeded([procedure()]);
    await bindIssue(repos, input);
    const events = await repos.audit.list('OPS-1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ issueKey: 'OPS-1', seq: 1, type: 'BOUND', actor: 'carol', at: NOW, payload: { pageId: 'P1', version: 3 } });
  });
});
