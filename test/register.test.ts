import { describe, expect, it } from 'vitest';
import { appendAudit } from '../src/domain/audit';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import { buildRegister, verifyRegisterChains } from '../src/domain/register';
import type { Binding, BindingState, Procedure } from '../src/domain/types';

const NOW = '2026-11-21T00:00:00.000Z';

const proc = (pageId: string, o: Partial<Procedure> = {}): Procedure => ({
  pageId,
  title: `Title ${pageId}`,
  controlled: true,
  policy: 'approved-only',
  approved: [],
  currentApproved: 3,
  lastSeenVersion: 4,
  ...o,
});

const bind = (
  id: string,
  issueKey: string,
  pageId: string,
  state: BindingState = 'CURRENT',
  o: Partial<Binding> = {},
): Binding => ({
  id,
  issueKey,
  pageId,
  boundVersion: 3,
  boundAt: NOW,
  boundBy: 'alice',
  state,
  ...o,
});

async function seed(procs: Procedure[], bs: Binding[]) {
  const repos = createMemoryRepos();
  for (const p of procs) await repos.procedures.put(p);
  for (const b of bs) await repos.bindings.put(b);
  return repos;
}
const all = async () => true;

describe('buildRegister', () => {
  it('restricted rows leak no page id, versions or live-derived status', async () => {
    // Stored CURRENT at v3, page approved v5: a visible row would read SUPERSEDED.
    const repos = await seed(
      [proc('1', { currentApproved: 5 })],
      [bind('CHG-1.1', 'CHG-1', '1', 'CURRENT', { boundVersion: 3 })],
    );
    const row = (await buildRegister({ repos, canView: async () => false }, { projectKey: 'CHG' })).rows[0];
    expect(row.status).toBe('CURRENT');
    expect(row.pageId).toBe('');
    expect(row.bindingId).not.toContain('1.1');
    expect(row).not.toHaveProperty('boundVersion');
    expect(row).not.toHaveProperty('currentApproved');
    expect(row).not.toHaveProperty('supersededBy');
    expect(row).not.toHaveProperty('title');
  });

  it('drops work items the viewer cannot browse (issue security); an error hides all', async () => {
    const repos = await seed([proc('1', { currentApproved: 3 })], [bind('a', 'CHG-1', '1'), bind('b', 'CHG-2', '1')]);
    const r = await buildRegister(
      { repos, canView: all, visibleIssues: async () => new Set(['CHG-2']) },
      { projectKey: 'CHG' },
    );
    expect(r.rows.map((x) => x.issueKey)).toEqual(['CHG-2']);
    const r2 = await buildRegister(
      {
        repos,
        canView: all,
        visibleIssues: async () => {
          throw new Error('x');
        },
      },
      { projectKey: 'CHG' },
    );
    expect(r2.rows).toEqual([]);
  });

  it('reports an open CURRENT binding behind the latest approved version as SUPERSEDED', async () => {
    const repos = await seed(
      [proc('1', { currentApproved: 5 })],
      [
        bind('a', 'CHG-1', '1', 'CURRENT', { boundVersion: 4 }),
        bind('b', 'CHG-2', '1', 'CURRENT', { boundVersion: 5 }),
      ],
    );
    const r = await buildRegister({ repos, canView: all }, { projectKey: 'CHG' });
    expect(r.rows.map((x) => [x.issueKey, x.status])).toEqual([
      ['CHG-1', 'SUPERSEDED'],
      ['CHG-2', 'CURRENT'],
    ]);
  });

  it('filters by project prefix', async () => {
    const repos = await seed([proc('1')], [bind('a', 'CHG-1', '1'), bind('b', 'CHGX-1', '1'), bind('c', 'OPS-1', '1')]);
    const r = await buildRegister({ repos, canView: all }, { projectKey: 'CHG' });
    expect(r.rows.map((x) => x.issueKey)).toEqual(['CHG-1']);
    expect(r.projectKey).toBe('CHG');
  });

  it('marks closed bindings as CLOSED', async () => {
    const repos = await seed([proc('1')], [bind('a', 'CHG-1', '1', 'CURRENT', { closedAt: NOW })]);
    const r = await buildRegister({ repos, canView: all }, { projectKey: 'CHG' });
    expect(r.rows[0].status).toBe('CLOSED');
    expect(r.rows[0].closedAt).toBe(NOW);
  });

  it('redacts restricted rows', async () => {
    const repos = await seed([proc('1')], [bind('a', 'CHG-1', '1', 'SUPERSEDED', { supersededBy: 4 })]);
    const r = await buildRegister({ repos, canView: async () => false }, { projectKey: 'CHG' });
    const row = r.rows[0];
    expect(row.restricted).toBe(true);
    expect(row.status).toBe('SUPERSEDED');
    expect(row).not.toHaveProperty('title');
    expect(row).not.toHaveProperty('currentApproved');
    expect(row).not.toHaveProperty('supersededBy');
  });

  it('shows details for visible rows', async () => {
    const repos = await seed(
      [proc('1', { currentApproved: 4 })],
      [bind('a', 'CHG-1', '1', 'SUPERSEDED', { supersededBy: 4 })],
    );
    const row = (await buildRegister({ repos, canView: all }, { projectKey: 'CHG' })).rows[0];
    expect(row).toMatchObject({
      restricted: false,
      title: 'Title 1',
      currentApproved: 4,
      supersededBy: 4,
      overridden: false,
    });
  });

  it('treats a canView error as restricted', async () => {
    const repos = await seed([proc('1')], [bind('a', 'CHG-1', '1')]);
    const canView = async () => {
      throw new Error('boom');
    };
    const r = await buildRegister({ repos, canView }, { projectKey: 'CHG' });
    expect(r.rows[0].restricted).toBe(true);
    expect(r.rows[0]).not.toHaveProperty('title');
  });

  it('calls canView once per page', async () => {
    const repos = await seed([proc('1')], [bind('a', 'CHG-1', '1'), bind('b', 'CHG-2', '1')]);
    let n = 0;
    await buildRegister({ repos, canView: async () => (n++, true) }, { projectKey: 'CHG' });
    expect(n).toBe(1);
  });

  it('sorts problems first, then natural issue order', async () => {
    const repos = await seed(
      [proc('1')],
      [
        bind('a', 'CHG-10', '1', 'CURRENT'),
        bind('b', 'CHG-2', '1', 'CURRENT'),
        bind('c', 'CHG-3', '1', 'CLEARED'),
        bind('d', 'CHG-4', '1', 'CURRENT', { closedAt: NOW }),
        bind('e', 'CHG-11', '1', 'SUPERSEDED'),
        bind('f', 'CHG-5', '1', 'ORPHANED'),
        bind('g', 'CHG-6', '1', 'REATTESTING'),
        bind('h', 'CHG-9', '1', 'SUPERSEDED'),
      ],
    );
    const r = await buildRegister({ repos, canView: all }, { projectKey: 'CHG' });
    expect(r.rows.map((x) => x.issueKey)).toEqual([
      'CHG-9',
      'CHG-11',
      'CHG-6',
      'CHG-5',
      'CHG-2',
      'CHG-10',
      'CHG-3',
      'CHG-4',
    ]);
  });

  it('counts per status', async () => {
    const repos = await seed(
      [proc('1')],
      [
        bind('a', 'CHG-1', '1'),
        bind('b', 'CHG-2', '1'),
        bind('c', 'CHG-3', '1', 'SUPERSEDED'),
        bind('d', 'CHG-4', '1', 'CURRENT', { closedAt: NOW }),
      ],
    );
    const { counts } = await buildRegister({ repos, canView: all }, { projectKey: 'CHG' });
    expect(counts).toEqual({
      SUPERSEDED: 1,
      REATTESTING: 0,
      ORPHANED: 0,
      CURRENT: 2,
      CLEARED: 0,
      CLOSED: 1,
    });
  });

  it('includes bindings on non-controlled pages with open bindings, without duplicates', async () => {
    const repos = await seed(
      [proc('1'), proc('2', { controlled: false })],
      [bind('a', 'CHG-1', '1'), bind('b', 'CHG-2', '2', 'SUPERSEDED')],
    );
    const r = await buildRegister({ repos, canView: all }, { projectKey: 'CHG' });
    expect(r.rows.map((x) => x.bindingId).sort()).toEqual(['a', 'b']);
  });

  it('flags overridden bindings', async () => {
    const override = { by: 'bob', at: NOW, reason: 'r', forVersion: 4 };
    const repos = await seed([proc('1')], [bind('a', 'CHG-1', '1', 'SUPERSEDED', { override })]);
    expect((await buildRegister({ repos, canView: all }, { projectKey: 'CHG' })).rows[0].overridden).toBe(true);
  });
});

describe('verifyRegisterChains truncation', () => {
  it('never reports a truncated run as a full pass', async () => {
    const repos = createMemoryRepos();
    const keys = Array.from({ length: 201 }, (_, i) => `CHG-${i + 1}`);
    const r = await verifyRegisterChains(repos, keys);
    expect(r.truncated).toBe(true);
    expect(r.allOk).toBe(false);
    expect(r.checked).toBe(200);
  });
});

describe('verifyRegisterChains', () => {
  it('accepts valid chains and detects a tampered one', async () => {
    const repos = createMemoryRepos();
    for (const key of ['CHG-1', 'CHG-2']) {
      await appendAudit(repos.audit, {
        issueKey: key,
        type: 'BOUND',
        actor: 'a',
        at: NOW,
        payload: { n: 1 },
      });
      await appendAudit(repos.audit, {
        issueKey: key,
        type: 'CLEARED',
        actor: 'a',
        at: NOW,
        payload: { n: 2 },
      });
    }
    const ok = await verifyRegisterChains(repos, ['CHG-1', 'CHG-2', 'CHG-1']);
    expect(ok).toMatchObject({ allOk: true, checked: 2 });

    const events = await repos.audit.list('CHG-2');
    const tampered = {
      ...repos,
      audit: {
        ...repos.audit,
        list: async (k: string) => (k === 'CHG-2' ? [events[0], { ...events[1], actor: 'evil' }] : repos.audit.list(k)),
      },
    };
    const bad = await verifyRegisterChains(tampered, ['CHG-1', 'CHG-2']);
    expect(bad.allOk).toBe(false);
    expect(bad.results.find((r) => r.issueKey === 'CHG-2')).toMatchObject({
      ok: false,
      firstBadSeq: 2,
    });
    expect(bad.results.find((r) => r.issueKey === 'CHG-1')?.ok).toBe(true);
  });
});
