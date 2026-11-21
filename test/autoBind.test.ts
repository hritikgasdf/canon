import { describe, expect, it } from 'vitest';
import { handleIssueUpdated } from '../src/domain/autoBind';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import type { Repos } from '../src/domain/repos';
import type { Procedure } from '../src/domain/types';

const NOW = '2026-11-21T00:00:00.000Z';
const now = () => NOW;

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

async function seeded(autoBind: Record<string, string>, procedures: Procedure[] = [procedure()]): Promise<Repos> {
  const repos = createMemoryRepos();
  for (const p of procedures) await repos.procedures.put(p);
  await repos.settings.put({ ...(await repos.settings.get()), autoBind });
  return repos;
}

function event(opts: { field?: string; category?: string; issueType?: string; projectKey?: string } = {}) {
  return {
    issue: {
      key: 'OPS-1',
      fields: {
        project: { key: opts.projectKey ?? 'OPS' },
        issuetype: { name: opts.issueType ?? 'Change' },
        status: { name: 'In Progress', statusCategory: { key: opts.category ?? 'indeterminate' } },
      },
    },
    changelog: { items: [{ field: opts.field ?? 'status', fromString: 'To Do', toString: 'In Progress' }] },
  };
}

describe('handleIssueUpdated', () => {
  it('binds on a start transition using the project/type key', async () => {
    const repos = await seeded({ 'OPS/Change': 'P1', Change: 'P9' });
    const result = await handleIssueUpdated(repos, event(), now);
    expect(result).toEqual({ action: 'BOUND', issueKey: 'OPS-1', pageId: 'P1', version: 3 });
    const b = await repos.bindings.get('OPS-1.P1');
    expect(b?.boundBy).toBe('canon:auto-bind');
    expect(b?.boundAt).toBe(NOW);
    expect(b?.state).toBe('CURRENT');
  });

  it('falls back to the issue-type-only key', async () => {
    const repos = await seeded({ Change: 'P1' });
    const result = await handleIssueUpdated(repos, event({ projectKey: 'OTHER' }), now);
    expect(result).toEqual({ action: 'BOUND', issueKey: 'OPS-1', pageId: 'P1', version: 3 });
  });

  it('ignores a changelog that does not touch status', async () => {
    const repos = await seeded({ Change: 'P1' });
    const result = await handleIssueUpdated(repos, event({ field: 'summary' }), now);
    expect(result).toEqual({ action: 'IGNORED', reason: 'not-start-transition' });
    expect(await repos.bindings.get('OPS-1.P1')).toBeNull();
  });

  it('ignores a transition into a non-indeterminate category (To Do or Done)', async () => {
    const repos = await seeded({ Change: 'P1' });
    expect(await handleIssueUpdated(repos, event({ category: 'new' }), now)).toEqual({
      action: 'IGNORED',
      reason: 'not-start-transition',
    });
    expect(await handleIssueUpdated(repos, event({ category: 'done' }), now)).toEqual({
      action: 'IGNORED',
      reason: 'not-start-transition',
    });
    expect(await repos.bindings.get('OPS-1.P1')).toBeNull();
  });

  it('ignores an issue with no autoBind mapping', async () => {
    const repos = await seeded({ Bug: 'P1' });
    const result = await handleIssueUpdated(repos, event(), now);
    expect(result).toEqual({ action: 'IGNORED', reason: 'no-mapping', issueKey: 'OPS-1' });
  });

  it('skips when the issue is already bound (ALREADY_BOUND)', async () => {
    const repos = await seeded({ Change: 'P1' });
    const first = await handleIssueUpdated(repos, event(), now);
    expect(first.action).toBe('BOUND');
    const second = await handleIssueUpdated(repos, event(), now);
    expect(second).toEqual({ action: 'SKIPPED', reason: 'ALREADY_BOUND', issueKey: 'OPS-1', pageId: 'P1' });
  });

  it('skips when the mapped page is not a controlled procedure', async () => {
    const repos = await seeded({ Change: 'P1' }, [procedure({ controlled: false })]);
    const result = await handleIssueUpdated(repos, event(), now);
    expect(result).toEqual({ action: 'SKIPPED', reason: 'NOT_CONTROLLED', issueKey: 'OPS-1', pageId: 'P1' });
  });

  it('returns IGNORED malformed for bad event shapes without throwing', async () => {
    const repos = await seeded({ Change: 'P1' });
    const bad: unknown[] = [
      null,
      'nope',
      42,
      {},
      { issue: 'x' },
      { issue: { key: 'OPS-1' } },
      { issue: { key: 'OPS-1', fields: { project: { key: 'OPS' }, issuetype: { name: 'Change' }, status: { statusCategory: { key: 'indeterminate' } } } } },
      { ...event(), changelog: { items: 'not-an-array' } },
      { ...event(), changelog: undefined },
    ];
    for (const e of bad) {
      expect(await handleIssueUpdated(repos, e, now)).toEqual({ action: 'IGNORED', reason: 'malformed' });
    }
    expect(await repos.bindings.get('OPS-1.P1')).toBeNull();
  });
});
