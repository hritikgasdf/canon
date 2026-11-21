import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import type { Repos } from '../src/domain/repos';
import { getBindingDelta } from '../src/domain/issueDelta';
import { ensureDelta, type BodyFetcher } from '../src/domain/supersede';
import type { Binding, Procedure } from '../src/domain/types';

const seed = (v: number): string => readFileSync(`seed/sop-pay-014/v${v}.xhtml`, 'utf8');
const bodies: Record<number, string> = { 3: seed(3), 4: seed(4) };
const P = 'p1';
const ISSUE = 'CHG-1';
const BINDING = 'CHG-1.p1';

function procedure(currentApproved: number | null): Procedure {
  return {
    pageId: P,
    spaceKey: 'OPS',
    title: 'SOP PAY-014',
    controlled: true,
    policy: 'approved-only',
    approved: [],
    currentApproved,
    lastSeenVersion: currentApproved,
  };
}

function binding(over: Partial<Binding> = {}): Binding {
  return {
    id: BINDING,
    issueKey: ISSUE,
    pageId: P,
    boundVersion: 3,
    boundAt: 't',
    boundBy: 'u',
    state: 'CURRENT',
    ...over,
  };
}

async function setup(currentApproved: number | null, over: Partial<Binding> = {}) {
  const repos: Repos = createMemoryRepos();
  await repos.procedures.put(procedure(currentApproved));
  await repos.bindings.put(binding(over));
  const fetchBody = vi.fn<BodyFetcher>(async (_p, v) => {
    const b = bodies[v];
    if (b === undefined) throw new Error(`no body ${v}`);
    return b;
  });
  return { repos, fetchBody };
}

describe('getBindingDelta', () => {
  it('throws NOT_FOUND for a binding on another issue or a missing binding', async () => {
    const { repos, fetchBody } = await setup(4);
    await expect(
      getBindingDelta(repos, fetchBody, { issueKey: 'CHG-OTHER', bindingId: BINDING }),
    ).rejects.toThrow('NOT_FOUND');
    await expect(getBindingDelta(repos, fetchBody, { issueKey: ISSUE, bindingId: 'nope' })).rejects.toThrow(
      'NOT_FOUND',
    );
    expect(fetchBody).not.toHaveBeenCalled();
  });

  it('returns an empty view when no newer approved version exists', async () => {
    const { repos, fetchBody } = await setup(3);
    const view = await getBindingDelta(repos, fetchBody, { issueKey: ISSUE, bindingId: BINDING });
    expect(view).toEqual({
      bindingId: BINDING,
      pageId: P,
      title: 'SOP PAY-014',
      fromVersion: 3,
      toVersion: null,
      items: [],
      counts: { ADDED: 0, REMOVED: 0, CHANGED: 0, MOVED: 0 },
      materialCount: 0,
    });
    expect(fetchBody).not.toHaveBeenCalled();
  });

  it('prefers supersededBy over currentApproved as the target', async () => {
    const { repos, fetchBody } = await setup(5, { state: 'SUPERSEDED', supersededBy: 4 });
    const view = await getBindingDelta(repos, fetchBody, { issueKey: ISSUE, bindingId: BINDING });
    expect(view.toVersion).toBe(4);
    expect(fetchBody.mock.calls.map((c) => c[1]).sort()).toEqual([3, 4]);
  });

  it('reuses a stored delta without fetching Confluence', async () => {
    const { repos, fetchBody } = await setup(4);
    await ensureDelta(repos, fetchBody, P, 3, 4);
    fetchBody.mockClear();
    const view = await getBindingDelta(repos, fetchBody, { issueKey: ISSUE, bindingId: BINDING });
    expect(view.toVersion).toBe(4);
    expect(fetchBody).not.toHaveBeenCalled();
  });

  it('computes a missing delta and tallies counts and materialCount', async () => {
    const { repos, fetchBody } = await setup(4);
    const view = await getBindingDelta(repos, fetchBody, { issueKey: ISSUE, bindingId: BINDING });
    expect(view.fromVersion).toBe(3);
    expect(view.toVersion).toBe(4);
    expect(view.items.length).toBeGreaterThan(0);
    expect(fetchBody).toHaveBeenCalledTimes(2);

    // Counts must match a manual tally of the returned items, trivial ones included.
    const tally = { ADDED: 0, REMOVED: 0, CHANGED: 0, MOVED: 0 };
    for (const i of view.items) tally[i.kind] += 1;
    expect(view.counts).toEqual(tally);
    expect(view.materialCount).toBe(view.items.filter((i) => !i.trivial).length);

    // Same material count the supersede test records for the same v3 -> v4 pair.
    expect(view.materialCount).toBe(3);
  });
});
