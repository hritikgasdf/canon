import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { procedureState } from '../src/domain/approve';
import { handleIssueUpdated } from '../src/domain/autoBind';
import { evaluateGate } from '../src/domain/gateEval';
import { summarizeIssue } from '../src/domain/issueSummary';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import type { Repos } from '../src/domain/repos';
import { supersede } from '../src/domain/supersede';
import type { Binding, Procedure } from '../src/domain/types';

const T0 = '2026-11-21T00:00:00.000Z';
const T1 = '2026-11-22T00:00:00.000Z';
const seed = (v: number): string => readFileSync(`seed/sop-pay-014/v${v}.xhtml`, 'utf8');
const fetchBody = async (_p: string, v: number): Promise<string> => seed(v);

const proc = (over: Partial<Procedure> = {}): Procedure => ({
  pageId: 'P1',
  title: 'SOP',
  controlled: true,
  policy: 'approved-only',
  approved: [],
  currentApproved: 3,
  lastSeenVersion: 3,
  ...over,
});

const binding = (over: Partial<Binding> = {}): Binding => ({
  id: 'OPS-1.P1',
  issueKey: 'OPS-1',
  pageId: 'P1',
  boundVersion: 3,
  boundAt: T0,
  boundBy: 'u',
  state: 'CURRENT',
  ...over,
});

function event(category: string) {
  return {
    issue: {
      key: 'OPS-1',
      fields: {
        project: { key: 'OPS' },
        issuetype: { name: 'Change' },
        status: { name: 'x', statusCategory: { key: category } },
      },
    },
    changelog: { items: [{ field: 'status' }] },
  };
}

async function setup(b: Partial<Binding> = {}): Promise<Repos> {
  const repos = createMemoryRepos();
  await repos.procedures.put(proc());
  await repos.bindings.put(binding(b));
  await repos.settings.put({ ...(await repos.settings.get()), autoBind: { Change: 'P1' } });
  return repos;
}

describe('work closed', () => {
  it('Done sets closedAt and audits WORK_CLOSED once', async () => {
    const repos = await setup();
    const r = await handleIssueUpdated(repos, event('done'), () => T1);
    expect(r.action).toBe('CLOSED');
    expect((await repos.bindings.get('OPS-1.P1'))?.closedAt).toBe(T1);
    const log = await repos.audit.list('OPS-1');
    expect(log).toHaveLength(1);
    expect(log[0]?.type).toBe('WORK_CLOSED');
    expect(log[0]?.payload).toEqual({ bindingIds: ['OPS-1.P1'], states: ['CURRENT'] });
  });

  it('closes bindings in any state', async () => {
    const repos = await setup({ state: 'SUPERSEDED', supersededBy: 4 });
    await handleIssueUpdated(repos, event('done'), () => T1);
    const b = await repos.bindings.get('OPS-1.P1');
    expect(b?.closedAt).toBe(T1);
    expect(b?.state).toBe('SUPERSEDED');
  });

  it('repeat Done event is idempotent', async () => {
    const repos = await setup();
    await handleIssueUpdated(repos, event('done'), () => T1);
    const r = await handleIssueUpdated(repos, event('done'), () => '2027-01-01T00:00:00.000Z');
    expect(r.action).toBe('IGNORED');
    expect((await repos.bindings.get('OPS-1.P1'))?.closedAt).toBe(T1);
    expect(await repos.audit.list('OPS-1')).toHaveLength(1);
  });

  it('a later approval does not supersede the closed binding', async () => {
    const repos = await setup({ closedAt: T1 });
    const r = await supersede(repos, fetchBody, { pageId: 'P1', toVersion: 4, actor: 'a', at: T1 });
    expect(r.superseded).toEqual([]);
    expect((await repos.bindings.get('OPS-1.P1'))?.state).toBe('CURRENT');
  });

  it('openBindings and listWithOpenBindings exclude closed bindings', async () => {
    const repos = await setup();
    expect((await procedureState(repos, 'P1')).openBindings).toBe(1);
    expect(await repos.procedures.listWithOpenBindings()).toEqual(['P1']);
    await handleIssueUpdated(repos, event('done'), () => T1);
    expect((await procedureState(repos, 'P1')).openBindings).toBe(0);
    expect(await repos.procedures.listWithOpenBindings()).toEqual([]);
  });

  it('reopen clears closedAt, audits, and the gate blocks on a newer approved version', async () => {
    const repos = await setup({ closedAt: T0 });
    await repos.procedures.put(proc({ currentApproved: 4, lastSeenVersion: 4 }));
    const r = await handleIssueUpdated(repos, event('new'), () => T1);
    expect(r.action).toBe('REOPENED');
    const bindings = await repos.bindings.listByIssue('OPS-1');
    expect(bindings[0]?.closedAt).toBeUndefined();
    expect((await repos.audit.list('OPS-1')).map((e) => e.type)).toEqual(['WORK_REOPENED']);
    const d = evaluateGate({
      issueKey: 'OPS-1',
      mode: 'block',
      bindings,
      procedures: { P1: await repos.procedures.get('P1') },
      liveVersions: { P1: 4 },
      attestations: {},
    });
    expect(d.allow).toBe(false);
    expect(d.reasons[0]?.code).toBe('SUPERSEDED');
  });

  it('reopen into In Progress clears closedAt then still runs auto-bind', async () => {
    const repos = await setup({ closedAt: T0 });
    const r = await handleIssueUpdated(repos, event('indeterminate'), () => T1);
    expect(r).toEqual({ action: 'SKIPPED', reason: 'ALREADY_BOUND', issueKey: 'OPS-1', pageId: 'P1' });
    expect((await repos.bindings.get('OPS-1.P1'))?.closedAt).toBeUndefined();
    expect((await repos.audit.list('OPS-1')).map((e) => e.type)).toEqual(['WORK_REOPENED']);
  });

  it('summary is CLOSED when every binding is closed', () => {
    const s = summarizeIssue([
      binding({ closedAt: T1, state: 'SUPERSEDED', supersededBy: 4 }),
      binding({ id: 'b2', pageId: 'P2', closedAt: T1, boundVersion: 7 }),
    ]);
    expect(s).toMatchObject({ state: 'CLOSED', bindingCount: 2, boundVersion: 7, targetVersion: null });
  });

  it('audit failure on Done leaves bindings unmodified', async () => {
    const repos = await setup();
    repos.audit.append = async () => {
      throw new Error('audit down');
    };
    await expect(handleIssueUpdated(repos, event('done'), () => T1)).rejects.toThrow('audit down');
    expect((await repos.bindings.get('OPS-1.P1'))?.closedAt).toBeUndefined();
  });

  it('audit failure on reopen leaves bindings unmodified', async () => {
    const repos = await setup({ closedAt: T0 });
    repos.audit.append = async () => {
      throw new Error('audit down');
    };
    await expect(handleIssueUpdated(repos, event('new'), () => T1)).rejects.toThrow('audit down');
    expect((await repos.bindings.get('OPS-1.P1'))?.closedAt).toBe(T0);
  });

  it('summary ignores closed bindings while another is open', () => {
    const s = summarizeIssue([
      binding({ closedAt: T1, state: 'SUPERSEDED', supersededBy: 4 }),
      binding({ id: 'b2', pageId: 'P2' }),
    ]);
    expect(s.state).toBe('CURRENT');
  });
});
