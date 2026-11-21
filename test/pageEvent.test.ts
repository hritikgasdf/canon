import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { handlePageEvent, type PageEventDeps } from '../src/domain/pageEvent';
import type { PageMeta } from '../src/domain/approve';
import type { Repos } from '../src/domain/repos';
import {
  DEFAULT_SETTINGS,
  type AuditEvent,
  type Binding,
  type BindingState,
  type Procedure,
} from '../src/domain/types';

const PAGE = '12345';
const NOW = '2026-11-21T00:00:00.000Z';

const v3 = readFileSync(new URL('../seed/sop-pay-014/v3.xhtml', import.meta.url), 'utf8');
const v4 = readFileSync(new URL('../seed/sop-pay-014/v4.xhtml', import.meta.url), 'utf8');
const BODIES: Record<number, string> = { 3: v3, 4: v4 };

function memoryRepos(): Repos {
  const procedures = new Map<string, Procedure>();
  const bindings = new Map<string, Binding>();
  const audit: AuditEvent[] = [];
  const snapshots = new Map<string, unknown>();
  const deltas = new Map<string, unknown>();
  const attestations = new Map<string, unknown>();
  let settings = { ...DEFAULT_SETTINGS };

  return {
    procedures: {
      async get(pageId) {
        return procedures.get(pageId) ?? null;
      },
      async put(p) {
        procedures.set(p.pageId, structuredClone(p));
      },
      async listWithOpenBindings() {
        const open: BindingState[] = ['CURRENT', 'SUPERSEDED', 'REATTESTING'];
        return [...new Set([...bindings.values()].filter((b) => open.includes(b.state)).map((b) => b.pageId))];
      },
      async listControlled() {
        return [...procedures.values()].filter((p) => p.controlled === true);
      },
    },
    snapshots: {
      async get(pageId, version) {
        return (snapshots.get(`${pageId}:${version}`) as never) ?? null;
      },
      async put(s) {
        snapshots.set(`${s.pageId}:${s.version}`, structuredClone(s));
      },
    },
    bindings: {
      async get(id) {
        return bindings.get(id) ?? null;
      },
      async put(b) {
        bindings.set(b.id, structuredClone(b));
      },
      async listByIssue(issueKey) {
        return [...bindings.values()].filter((b) => b.issueKey === issueKey).map((b) => structuredClone(b));
      },
      async listByPage(pageId, states) {
        return [...bindings.values()]
          .filter((b) => b.pageId === pageId && (!states || states.includes(b.state)))
          .map((b) => structuredClone(b));
      },
    },
    deltas: {
      async get(pageId, from, to) {
        return (deltas.get(`${pageId}:${from}:${to}`) as never) ?? null;
      },
      async put(d) {
        deltas.set(`${d.pageId}:${d.fromVersion}:${d.toVersion}`, structuredClone(d));
      },
    },
    attestations: {
      async get(bindingId, toVersion) {
        return (attestations.get(`${bindingId}:${toVersion}`) as never) ?? null;
      },
      async put(a) {
        attestations.set(`${a.bindingId}:${a.toVersion}`, structuredClone(a));
      },
    },
    audit: {
      async last(issueKey) {
        const list = audit.filter((e) => e.issueKey === issueKey);
        return list.length ? structuredClone(list[list.length - 1]!) : null;
      },
      async append(e) {
        audit.push(structuredClone(e));
      },
      async list(issueKey) {
        return audit.filter((e) => e.issueKey === issueKey).map((e) => structuredClone(e));
      },
    },
    settings: {
      async get() {
        return structuredClone(settings);
      },
      async put(s) {
        settings = structuredClone(s);
      },
    },
    sample: {
      async get() {
        return null;
      },
      async put() {},
    },
  };
}

function procedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    pageId: PAGE,
    title: 'SOP-PAY-014',
    controlled: true,
    policy: 'approved-only',
    approved: [{ version: 3, approvedBy: 'bob', approvedAt: NOW, bodyHash: 'h3', minorEdit: false }],
    currentApproved: 3,
    lastSeenVersion: 3,
    ...overrides,
  };
}

function binding(id: string, issueKey: string, state: BindingState = 'CURRENT'): Binding {
  return { id, issueKey, pageId: PAGE, boundVersion: 3, boundAt: NOW, boundBy: 'alice', state };
}

function meta(overrides: Partial<PageMeta> = {}): PageMeta {
  return {
    pageId: PAGE,
    title: 'SOP-PAY-014',
    currentVersion: 4,
    lastEditorId: 'alice',
    minorEdit: false,
    ...overrides,
  };
}

function updated(version: number, eventType = 'avi:confluence:updated:page') {
  return { eventType, content: { id: PAGE, version: { number: version } } };
}

function makeDeps(m: PageMeta = meta()): PageEventDeps & { metaCalls: number } {
  const deps = {
    metaCalls: 0,
    async getPageMeta() {
      deps.metaCalls += 1;
      return m;
    },
    async fetchBody(_pageId: string, version: number) {
      const body = BODIES[version];
      if (body === undefined) throw new Error(`no fixture for v${version}`);
      return body;
    },
    now: () => NOW,
  };
  return deps;
}

describe('handlePageEvent', () => {
  it('ignores events for a page that is not a controlled procedure', async () => {
    const repos = memoryRepos();
    const deps = makeDeps();
    expect((await handlePageEvent(repos, deps, updated(4))).action).toBe('IGNORED');

    await repos.procedures.put(procedure({ controlled: false }));
    const r = await handlePageEvent(repos, deps, updated(4));
    expect(r).toEqual({ action: 'IGNORED', reason: 'not controlled' });
    expect(deps.metaCalls).toBe(0);
  });

  it('ignores malformed events', async () => {
    const repos = memoryRepos();
    await repos.procedures.put(procedure());
    const deps = makeDeps();
    const bad: unknown[] = [
      null,
      'avi:confluence:updated:page',
      { eventType: 42, content: { id: PAGE, version: { number: 4 } } },
      { eventType: 'avi:confluence:updated:page', content: { version: { number: 4 } } },
      { eventType: 'avi:confluence:updated:page', content: { id: PAGE, version: { number: 4.5 } } },
      { eventType: 'avi:confluence:updated:page', content: { id: PAGE, version: 'four' } },
      { eventType: 'avi:confluence:updated:page', content: { id: PAGE } },
    ];
    for (const event of bad) {
      const r = await handlePageEvent(repos, deps, event);
      expect(r.action).toBe('IGNORED');
    }
  });

  it('approved-only policy records the draft and does not approve', async () => {
    const repos = memoryRepos();
    await repos.procedures.put(procedure({ lastSeenVersion: 3 }));
    const deps = makeDeps(meta({ currentVersion: 4 }));

    const r = await handlePageEvent(repos, deps, updated(4));
    expect(r).toEqual({ action: 'DRAFT_SEEN', pageId: PAGE, version: 4 });
    expect(deps.metaCalls).toBe(0);

    const p = await repos.procedures.get(PAGE);
    expect(p?.lastSeenVersion).toBe(4);
    expect(p?.lastCheckedAt).toBe(NOW);
    expect(p?.currentApproved).toBe(3);
  });

  it('every-major + major edit auto-approves and supersedes the CURRENT binding', async () => {
    const repos = memoryRepos();
    await repos.procedures.put(procedure({ policy: 'every-major' }));
    await repos.bindings.put(binding('b1', 'PAY-1'));
    const deps = makeDeps(meta({ currentVersion: 4, minorEdit: false }));

    const r = await handlePageEvent(repos, deps, updated(4));
    expect(r).toEqual({ action: 'AUTO_APPROVED', pageId: PAGE, version: 4, superseded: ['b1'] });

    const p = await repos.procedures.get(PAGE);
    expect(p?.currentApproved).toBe(4);
    expect(p?.approved.at(-1)?.approvedBy).toBe('canon:auto');

    const b = await repos.bindings.get('b1');
    expect(b?.state).toBe('SUPERSEDED');
    expect(b?.supersededBy).toBe(4);
    expect(b?.boundVersion).toBe(3);
  });

  it('every-major + minor edit records the draft only', async () => {
    const repos = memoryRepos();
    await repos.procedures.put(procedure({ policy: 'every-major' }));
    await repos.bindings.put(binding('b1', 'PAY-1'));
    const deps = makeDeps(meta({ currentVersion: 4, minorEdit: true }));

    const r = await handlePageEvent(repos, deps, updated(4));
    expect(r).toEqual({ action: 'DRAFT_SEEN', pageId: PAGE, version: 4 });
    expect((await repos.procedures.get(PAGE))?.currentApproved).toBe(3);
    expect((await repos.bindings.get('b1'))?.state).toBe('CURRENT');
  });

  it('every-major + typo-only edit records the draft as trivial-only', async () => {
    const repos = memoryRepos();
    await repos.procedures.put(
      procedure({
        policy: 'every-major',
        currentApproved: 4,
        approved: [{ version: 4, approvedBy: 'bob', approvedAt: NOW, bodyHash: 'h4', minorEdit: false }],
      }),
    );
    await repos.bindings.put({ ...binding('b1', 'PAY-1'), boundVersion: 4 });
    const typo = v4.replace('backup processor is', 'backup procesor is');
    expect(typo).not.toBe(v4);
    BODIES[5] = typo;
    try {
      const deps = makeDeps(meta({ currentVersion: 5, minorEdit: false }));
      const r = await handlePageEvent(repos, deps, updated(5));
      expect(r).toEqual({ action: 'DRAFT_SEEN', pageId: PAGE, version: 5, reason: 'trivial-only' });
      expect((await repos.procedures.get(PAGE))?.currentApproved).toBe(4);
      expect((await repos.bindings.get('b1'))?.state).toBe('CURRENT');
    } finally {
      delete BODIES[5];
    }
  });

  it('stale event (page already moved on) records the draft only', async () => {
    const repos = memoryRepos();
    await repos.procedures.put(procedure({ policy: 'every-major' }));
    await repos.bindings.put(binding('b1', 'PAY-1'));
    const deps = makeDeps(meta({ currentVersion: 5, minorEdit: false }));

    const r = await handlePageEvent(repos, deps, updated(4));
    expect(r).toEqual({ action: 'DRAFT_SEEN', pageId: PAGE, version: 4 });
    expect((await repos.procedures.get(PAGE))?.currentApproved).toBe(3);
    expect((await repos.bindings.get('b1'))?.state).toBe('CURRENT');
  });

  it('duplicate event delivery is idempotent: no second approval or supersede', async () => {
    const repos = memoryRepos();
    await repos.procedures.put(procedure({ policy: 'every-major' }));
    await repos.bindings.put(binding('b1', 'PAY-1'));
    const deps = makeDeps(meta({ currentVersion: 4, minorEdit: false }));

    const first = await handlePageEvent(repos, deps, updated(4));
    expect(first.action).toBe('AUTO_APPROVED');
    const second = await handlePageEvent(repos, deps, updated(4));
    expect(second).toEqual({ action: 'DRAFT_SEEN', pageId: PAGE, version: 4 });

    const p = await repos.procedures.get(PAGE);
    expect(p?.approved).toHaveLength(2);
    const supersededEvents = (await repos.audit.list('PAY-1')).filter((e) => e.type === 'SUPERSEDED');
    expect(supersededEvents).toHaveLength(1);
  });

  it('trashed page orphans open bindings and writes audit events', async () => {
    const repos = memoryRepos();
    await repos.procedures.put(procedure());
    await repos.bindings.put(binding('b1', 'PAY-1', 'CURRENT'));
    await repos.bindings.put(binding('b2', 'PAY-2', 'SUPERSEDED'));
    await repos.bindings.put(binding('b3', 'PAY-3', 'CLEARED'));
    const deps = makeDeps();
    const event = { eventType: 'avi:confluence:trashed:page', content: { id: PAGE } };

    const r = await handlePageEvent(repos, deps, event);
    expect(r).toEqual({ action: 'ORPHANED', pageId: PAGE, bindings: ['b1', 'b2'] });

    expect((await repos.bindings.get('b1'))?.state).toBe('ORPHANED');
    expect((await repos.bindings.get('b2'))?.state).toBe('ORPHANED');
    expect((await repos.bindings.get('b3'))?.state).toBe('CLEARED');
    expect((await repos.procedures.get(PAGE))?.orphaned).toBe(true);

    const audit = await repos.audit.list('PAY-1');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.type).toBe('BINDING_ORPHANED');
    expect(audit[0]?.actor).toBe('canon:system');
    expect(audit[0]?.payload).toEqual({ pageId: PAGE, bindingId: 'b1', eventType: 'avi:confluence:trashed:page' });
  });

  it('archived and deleted events also orphan bindings', async () => {
    for (const eventType of ['avi:confluence:archived:page', 'avi:confluence:deleted:page']) {
      const repos = memoryRepos();
      await repos.bindings.put(binding('b1', 'PAY-1'));
      const r = await handlePageEvent(repos, makeDeps(), { eventType, content: { id: PAGE } });
      expect(r).toEqual({ action: 'ORPHANED', pageId: PAGE, bindings: ['b1'] });
      expect((await repos.bindings.get('b1'))?.state).toBe('ORPHANED');
    }
  });

  it('unknown eventType is ignored', async () => {
    const repos = memoryRepos();
    await repos.procedures.put(procedure());
    const r = await handlePageEvent(repos, makeDeps(), updated(4, 'avi:confluence:labeled:page'));
    expect(r.action).toBe('IGNORED');
    expect((await repos.procedures.get(PAGE))?.lastSeenVersion).toBe(3);
  });
});
