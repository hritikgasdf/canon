import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { bindingDeltaHandler } from '../src/forge/deltaResolver';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import type { Repos } from '../src/domain/repos';
import type { BodyFetcher } from '../src/domain/supersede';
import type { Binding, Procedure } from '../src/domain/types';

const seed = (v: number): string => readFileSync(`seed/sop-pay-014/v${v}.xhtml`, 'utf8');
const bodies: Record<number, string> = { 3: seed(3), 4: seed(4) };
const P = 'p1';
const ISSUE = 'CHG-1';
const BINDING = 'CHG-1.p1';

const req = (issueKey: string | undefined, bindingId: unknown = BINDING) => ({
  context: { accountId: 'u1', extension: { issue: issueKey === undefined ? undefined : { key: issueKey } } },
  payload: { bindingId },
});

async function setup() {
  const repos: Repos = createMemoryRepos();
  const procedure: Procedure = {
    pageId: P,
    spaceKey: 'OPS',
    title: 'SOP PAY-014',
    controlled: true,
    policy: 'approved-only',
    approved: [],
    currentApproved: 4,
    lastSeenVersion: 4,
  };
  const binding: Binding = {
    id: BINDING,
    issueKey: ISSUE,
    pageId: P,
    boundVersion: 3,
    boundAt: 't',
    boundBy: 'u',
    state: 'CURRENT',
  };
  await repos.procedures.put(procedure);
  await repos.bindings.put(binding);
  const fetchBody = vi.fn<BodyFetcher>(async (_p, v) => {
    const b = bodies[v];
    if (b === undefined) throw new Error(`no body ${v}`);
    return b;
  });
  const canView = vi.fn<(pageId: string) => Promise<boolean>>(async () => true);
  return { repos, fetchBody, canView };
}

describe('bindingDeltaHandler', () => {
  it('returns NO_CONTEXT when the issue or user context is missing', async () => {
    const { repos, fetchBody, canView } = await setup();
    const noIssue = await bindingDeltaHandler(req(undefined), { repos, canView, fetchBody });
    expect(noIssue).toMatchObject({ ok: false, error: 'NO_CONTEXT' });
    const noUser = await bindingDeltaHandler(
      { context: { extension: { issue: { key: ISSUE } } }, payload: { bindingId: BINDING } },
      { repos, canView, fetchBody },
    );
    expect(noUser).toMatchObject({ ok: false, error: 'NO_CONTEXT' });
    expect(canView).not.toHaveBeenCalled();
    expect(fetchBody).not.toHaveBeenCalled();
  });

  it('returns INVALID_INPUT for a missing or empty bindingId', async () => {
    const { repos, fetchBody, canView } = await setup();
    const res = await bindingDeltaHandler(req(ISSUE, ''), { repos, canView, fetchBody });
    expect(res).toMatchObject({ ok: false, error: 'INVALID_INPUT' });
  });

  it('returns NO_ACCESS when the user cannot view the page, and never fetches a body', async () => {
    const { repos, fetchBody, canView } = await setup();
    canView.mockResolvedValue(false);
    const res = await bindingDeltaHandler(req(ISSUE), { repos, canView, fetchBody });
    expect(res).toMatchObject({ ok: false, error: 'NO_ACCESS' });
    expect(canView).toHaveBeenCalledWith(P);
    expect(fetchBody).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND for a binding that belongs to another issue', async () => {
    const { repos, fetchBody, canView } = await setup();
    const res = await bindingDeltaHandler(req('CHG-OTHER'), { repos, canView, fetchBody });
    expect(res).toMatchObject({ ok: false, error: 'NOT_FOUND' });
    expect(fetchBody).not.toHaveBeenCalled();
  });

  it('returns the delta on the happy path', async () => {
    const { repos, fetchBody, canView } = await setup();
    const res = await bindingDeltaHandler(req(ISSUE), { repos, canView, fetchBody });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delta).toMatchObject({
      bindingId: BINDING,
      pageId: P,
      status: 'CHANGES',
      fromVersion: 3,
      toVersion: 4,
      materialCount: 3,
    });
    expect(res.delta.items.length).toBeGreaterThan(0);
    expect(fetchBody).toHaveBeenCalled();
  });
});
