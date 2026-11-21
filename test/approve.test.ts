import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { approveVersion, ApproveError, markControlled, procedureState, type PageMeta } from '../src/domain/approve';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import type { BodyFetcher } from '../src/domain/supersede';

const seed = (v: number): string => readFileSync(`seed/sop-pay-014/v${v}.xhtml`, 'utf8');
const fetchBody: BodyFetcher = async (_p, v) => seed(v);
const P = 'p1';
const at = '2026-01-01T00:00:00Z';
const meta = (over: Partial<PageMeta> = {}): PageMeta => ({
  pageId: P,
  title: 'SOP',
  currentVersion: 3,
  lastEditorId: 'editor',
  minorEdit: false,
  ...over,
});

async function controlled() {
  const repos = createMemoryRepos();
  await markControlled(repos, meta(), { actor: 'a', at });
  return repos;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApproveError) return e.code;
    throw e;
  }
  return 'NONE';
}

describe('approve', () => {
  it('markControlled creates and is idempotent', async () => {
    const repos = createMemoryRepos();
    const a = await markControlled(repos, meta(), { actor: 'a', at });
    expect(a).toMatchObject({ controlled: true, approved: [], currentApproved: null, lastSeenVersion: 3 });
    const b = await markControlled(repos, meta({ currentVersion: 9 }), { actor: 'a', at });
    expect(b).toEqual(a);
  });

  it('approves v3 first time without supersede', async () => {
    const repos = await controlled();
    const r = await approveVersion(repos, fetchBody, meta(), { version: 3, actor: 'approver', at });
    expect(r.supersede).toBeNull();
    expect(r.procedure.currentApproved).toBe(3);
    expect(r.procedure.approved[0]).toMatchObject({ version: 3, approvedBy: 'approver', minorEdit: false });
    expect(r.procedure.approved[0]?.bodyHash).toMatch(/\S/);
  });

  it('approving v4 supersedes a CURRENT v3 binding', async () => {
    const repos = await controlled();
    await approveVersion(repos, fetchBody, meta(), { version: 3, actor: 'approver', at });
    await repos.bindings.put({ id: 'b1', issueKey: 'CHG-1', pageId: P, boundVersion: 3, boundAt: 't', boundBy: 'u', state: 'CURRENT' });
    const r = await approveVersion(repos, fetchBody, meta({ currentVersion: 4 }), { version: 4, actor: 'approver', at });
    expect(r.supersede?.superseded).toEqual(['b1']);
    expect((await repos.bindings.get('b1'))?.state).toBe('SUPERSEDED');
    expect(r.procedure.currentApproved).toBe(4);
  });

  it('refuses self-approval when required', async () => {
    const repos = await controlled();
    expect(await codeOf(approveVersion(repos, fetchBody, meta(), { version: 3, actor: 'editor', at }))).toBe('SELF_APPROVAL');
    expect((await repos.procedures.get(P))?.currentApproved).toBeNull();
  });

  it('allows self-approval when setting is false', async () => {
    const repos = await controlled();
    await repos.settings.put({ ...(await repos.settings.get()), requireIndependentApprover: false });
    const r = await approveVersion(repos, fetchBody, meta(), { version: 3, actor: 'editor', at });
    expect(r.procedure.currentApproved).toBe(3);
  });

  it('NOT_LATEST when meta.currentVersion differs', async () => {
    const repos = await controlled();
    expect(await codeOf(approveVersion(repos, fetchBody, meta({ currentVersion: 4 }), { version: 3, actor: 'x', at }))).toBe('NOT_LATEST');
  });

  it('ALREADY_APPROVED when version equals current approved', async () => {
    const repos = await controlled();
    await approveVersion(repos, fetchBody, meta(), { version: 3, actor: 'x', at });
    expect(await codeOf(approveVersion(repos, fetchBody, meta(), { version: 3, actor: 'y', at }))).toBe('ALREADY_APPROVED');
  });

  it('STALE_VERSION when lower than current approved', async () => {
    const repos = await controlled();
    await approveVersion(repos, fetchBody, meta({ currentVersion: 4 }), { version: 4, actor: 'x', at });
    expect(await codeOf(approveVersion(repos, fetchBody, meta({ currentVersion: 3 }), { version: 3, actor: 'y', at }))).toBe('STALE_VERSION');
  });

  it('NOT_CONTROLLED when procedure missing', async () => {
    const repos = createMemoryRepos();
    expect(await codeOf(approveVersion(repos, fetchBody, meta(), { version: 3, actor: 'x', at }))).toBe('NOT_CONTROLLED');
  });

  it('NOT_CONTROLLED when procedure exists but is not controlled', async () => {
    const repos = createMemoryRepos();
    await repos.procedures.put({ pageId: P, title: 'SOP', controlled: false, policy: 'approved-only', approved: [], currentApproved: null, lastSeenVersion: 3 });
    expect(await codeOf(approveVersion(repos, fetchBody, meta(), { version: 3, actor: 'x', at }))).toBe('NOT_CONTROLLED');
  });

  it('procedureState counts open bindings and pending draft', async () => {
    const repos = await controlled();
    expect(await procedureState(repos, 'nope')).toEqual({ procedure: null, openBindings: 0, pendingDraft: false });
    expect((await procedureState(repos, P)).pendingDraft).toBe(true);
    await approveVersion(repos, fetchBody, meta(), { version: 3, actor: 'x', at });
    const mk = (id: string, state: 'CURRENT' | 'SUPERSEDED' | 'REATTESTING' | 'CLEARED' | 'ORPHANED') =>
      repos.bindings.put({ id, issueKey: `CHG-${id}`, pageId: P, boundVersion: 3, boundAt: 't', boundBy: 'u', state });
    await mk('1', 'CURRENT');
    await mk('2', 'SUPERSEDED');
    await mk('3', 'REATTESTING');
    await mk('4', 'CLEARED');
    await mk('5', 'ORPHANED');
    expect(await procedureState(repos, P)).toMatchObject({ openBindings: 3, pendingDraft: false });
  });
});
