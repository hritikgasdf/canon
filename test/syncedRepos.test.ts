import { describe, expect, it } from 'vitest';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import { withIssueSync } from '../src/domain/syncedRepos';
import { summarizeIssue } from '../src/domain/issueSummary';
import type { Binding } from '../src/domain/types';

function binding(id: string, over: Partial<Binding> = {}): Binding {
  return {
    id,
    issueKey: 'CAN-1',
    pageId: 'P1',
    boundVersion: 2,
    boundAt: '2026-01-01T00:00:00.000Z',
    boundBy: 'acc-1',
    state: 'CURRENT',
    ...over,
  };
}

type Summary = ReturnType<typeof summarizeIssue>;

describe('withIssueSync', () => {
  it('syncs the recomputed summary of all bindings on the issue after a put', async () => {
    const calls: { issueKey: string; summary: Summary }[] = [];
    const repos = withIssueSync(createMemoryRepos(), async (issueKey, summary) => {
      calls.push({ issueKey, summary });
    });

    await repos.bindings.put(binding('a', { boundVersion: 2 }));
    await repos.bindings.put(binding('b', { pageId: 'P2', state: 'SUPERSEDED', boundVersion: 1, supersededBy: 3 }));

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      issueKey: 'CAN-1',
      summary: { state: 'CURRENT', bindingCount: 1, boundVersion: 2, targetVersion: null, pageIds: ['P1'] },
    });
    expect(calls[1]).toEqual({
      issueKey: 'CAN-1',
      summary: { state: 'SUPERSEDED', bindingCount: 2, boundVersion: 1, targetVersion: 3, pageIds: ['P1', 'P2'] },
    });
  });

  it('does not throw from put when sync throws, and logs the failure', async () => {
    const logs: string[] = [];
    const inner = createMemoryRepos();
    const repos = withIssueSync(
      inner,
      async () => {
        throw new Error('Jira 503');
      },
      (msg) => logs.push(msg),
    );

    await expect(repos.bindings.put(binding('a'))).resolves.toBeUndefined();
    expect(await inner.bindings.get('a')).not.toBeNull();
    expect(logs).toEqual(['issue sync failed for CAN-1: Jira 503']);
  });

  it('passes procedures, snapshots, deltas, attestations, audit and settings through untouched', async () => {
    const inner = createMemoryRepos();
    let syncCalls = 0;
    const repos = withIssueSync(inner, async () => {
      syncCalls++;
    });

    expect(repos.procedures).toBe(inner.procedures);
    expect(repos.snapshots).toBe(inner.snapshots);
    expect(repos.deltas).toBe(inner.deltas);
    expect(repos.attestations).toBe(inner.attestations);
    expect(repos.audit).toBe(inner.audit);
    expect(repos.settings).toBe(inner.settings);

    await repos.settings.put({ ...(await repos.settings.get()), validatorMode: 'warn' });
    expect(syncCalls).toBe(0);
  });
});
