import { describe, expect, it } from 'vitest';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import { buildIssueView, RESTRICTED_LABEL } from '../src/domain/issueView';
import type { Repos } from '../src/domain/repos';
import type { Binding, BindingState, Procedure } from '../src/domain/types';

const NOW = '2026-11-21T00:00:00.000Z';

function procedure(pageId: string, overrides: Partial<Procedure> = {}): Procedure {
  return {
    pageId,
    title: `Title ${pageId}`,
    controlled: true,
    policy: 'approved-only',
    approved: [],
    currentApproved: 3,
    lastSeenVersion: 3,
    ...overrides,
  };
}

function binding(id: string, pageId: string, state: BindingState = 'CURRENT', boundVersion = 3): Binding {
  return { id, issueKey: 'OPS-1', pageId, boundVersion, boundAt: NOW, boundBy: 'alice', state };
}

async function seeded(bindings: Binding[], procedures: Procedure[]): Promise<Repos> {
  const repos = createMemoryRepos();
  for (const p of procedures) await repos.procedures.put(p);
  for (const b of bindings) await repos.bindings.put(b);
  return repos;
}

const allowAll = { canView: async () => true };

describe('buildIssueView', () => {
  it('returns an empty binding list when the issue has no bindings', async () => {
    const repos = await seeded([], []);
    const view = await buildIssueView(repos, 'OPS-1', allowAll);
    expect(view).toEqual({ issueKey: 'OPS-1', bindings: [] });
  });

  it('includes title and currentApproved for a visible binding', async () => {
    const repos = await seeded([binding('b1', 'P1')], [procedure('P1', { currentApproved: 3 })]);
    const view = await buildIssueView(repos, 'OPS-1', allowAll);
    expect(view.bindings).toEqual([
      {
        id: 'b1',
        pageId: 'P1',
        state: 'CURRENT',
        boundVersion: 3,
        restricted: false,
        title: 'Title P1',
        currentApproved: 3,
        latestDeltaKey: null,
      },
    ]);
  });

  it('hides title, currentApproved and latestDeltaKey for a restricted binding', async () => {
    const repos = await seeded(
      [binding('b1', 'P1', 'SUPERSEDED', 2)],
      [procedure('P1', { title: 'Secret SOP', currentApproved: 4 })],
    );
    const view = await buildIssueView(repos, 'OPS-1', { canView: async () => false });
    const [b] = view.bindings;
    expect(b).toEqual({ id: 'b1', pageId: 'P1', state: 'SUPERSEDED', boundVersion: 2, restricted: true });
    expect(b).not.toHaveProperty('title');
    expect(b).not.toHaveProperty('currentApproved');
    expect(b).not.toHaveProperty('latestDeltaKey');
    expect(JSON.stringify(view)).not.toContain('Secret SOP');
    expect(RESTRICTED_LABEL).toBe('Procedure restricted');
  });

  it('treats a throwing canView as restricted and does not leak the title', async () => {
    const repos = await seeded([binding('b1', 'P1')], [procedure('P1', { title: 'Leaky Title' })]);
    const view = await buildIssueView(repos, 'OPS-1', {
      canView: async () => {
        throw new Error('network down');
      },
    });
    expect(view.bindings[0]).toMatchObject({ id: 'b1', restricted: true });
    expect(view.bindings[0]).not.toHaveProperty('title');
    expect(JSON.stringify(view)).not.toContain('Leaky Title');
  });

  it('gives a superseded binding a latestDeltaKey when a newer version is approved', async () => {
    const repos = await seeded(
      [binding('b1', 'P1', 'SUPERSEDED', 2), binding('b2', 'P2', 'REATTESTING', 1), binding('b3', 'P3', 'CURRENT', 1)],
      [
        procedure('P1', { currentApproved: 5 }),
        procedure('P2', { currentApproved: 3 }),
        procedure('P3', { currentApproved: 4 }),
      ],
    );
    const view = await buildIssueView(repos, 'OPS-1', allowAll);
    const byId = Object.fromEntries(view.bindings.map((b) => [b.id, b]));
    expect(byId.b1?.latestDeltaKey).toEqual({ from: 2, to: 5 });
    expect(byId.b2?.latestDeltaKey).toEqual({ from: 1, to: 3 });
    // CURRENT bindings never get a delta key, even if a newer version exists.
    expect(byId.b3?.latestDeltaKey).toBeNull();
  });
});
