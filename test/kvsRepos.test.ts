import { describe, expect, it } from 'vitest';
import { createKvsRepos, type KvsQueryLike, type KvsStoreLike } from '../src/forge/kvsRepos';
import type { Binding, BindingState } from '../src/domain/types';
import { runRepoContract } from './repoContract';

const KEY_PATTERN = /^[a-zA-Z0-9:._#-]+$/;

/**
 * In-memory fake of the subset of the Forge KVS API used by createKvsRepos.
 * Values are stored as JSON (like the real service). Keys outside the allowed
 * pattern are rejected. Queries paginate with `pageSize` and return an opaque cursor.
 */
function createFakeKvs(pageSize = 2) {
  const data = new Map<string, string>();
  let queryCalls = 0;

  const checkKey = (key: string) => {
    if (!KEY_PATTERN.test(key)) throw new Error(`Rejected KVS key: ${key}`);
  };

  const store: KvsStoreLike = {
    async get<T>(key: string) {
      checkKey(key);
      const raw = data.get(key);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    async set<T>(key: string, value: T) {
      checkKey(key);
      data.set(key, JSON.stringify(value));
      return undefined;
    },
    async delete(key: string) {
      checkKey(key);
      data.delete(key);
    },
    query(): KvsQueryLike {
      let prefix = '';
      let limit = pageSize;
      let offset = 0;
      const builder: KvsQueryLike = {
        where(_property, condition) {
          if (condition.condition !== 'BEGINS_WITH') throw new Error('Unsupported condition');
          prefix = String(condition.values[0]);
          return builder;
        },
        cursor(cursor) {
          offset = Number(cursor);
          return builder;
        },
        limit(n) {
          limit = Math.min(n, pageSize);
          return builder;
        },
        async getMany<T>() {
          queryCalls += 1;
          const matching = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
          const slice = matching.slice(offset, offset + limit);
          const next = offset + limit;
          const results = slice.map((key) => ({ key, value: JSON.parse(data.get(key)!) as T }));
          return next < matching.length ? { results, nextCursor: String(next) } : { results };
        },
      };
      return builder;
    },
  };

  return {
    store,
    keys: () => [...data.keys()],
    queryCalls: () => queryCalls,
  };
}

const binding = (id: string, issueKey: string, pageId: string, state: BindingState): Binding => ({
  id,
  issueKey,
  pageId,
  boundVersion: 1,
  boundAt: '2026-01-02T00:00:00Z',
  boundBy: 'bob',
  state,
});

runRepoContract('kvs', () => createKvsRepos(createFakeKvs(2).store));

describe('kvs repos extra', () => {
  it('listControlled pages through proc: keys and caps the result at 200', async () => {
    const fake = createFakeKvs(2);
    const repos = createKvsRepos(fake.store);
    for (let i = 1; i <= 205; i++) {
      await repos.procedures.put({
        pageId: `C${i}`,
        title: `Controlled ${i}`,
        controlled: true,
        policy: 'approved-only',
        approved: [],
        currentApproved: null,
        lastSeenVersion: null,
      });
    }
    await repos.procedures.put({
      pageId: 'U1',
      title: 'Uncontrolled',
      controlled: false,
      policy: 'approved-only',
      approved: [],
      currentApproved: null,
      lastSeenVersion: null,
    });
    const listed = await repos.procedures.listControlled();
    expect(listed).toHaveLength(200);
    expect(listed.every((p) => p.controlled === true)).toBe(true);
  });

  it('paginates across more than 5 bindings for one page and one issue', async () => {
    const fake = createFakeKvs(2);
    const repos = createKvsRepos(fake.store);
    for (let i = 1; i <= 7; i++) {
      const state: BindingState = i % 2 === 0 ? 'CLEARED' : 'CURRENT';
      await repos.bindings.put(binding(`b${i}`, `OPS-${i}`, 'P1', state));
    }
    for (let i = 1; i <= 6; i++) {
      await repos.bindings.put(binding(`c${i}`, 'OPS-SHARED', `P${i + 1}`, 'CURRENT'));
    }
    await repos.bindings.put(binding('d1', 'OPS-SHARED', 'P1', 'CURRENT'));
    await repos.bindings.put(binding('d2', 'OPS-SHARED', 'P1', 'CLEARED'));

    const before = fake.queryCalls();
    const onPage = await repos.bindings.listByPage('P1');
    expect(onPage.map((b) => b.id).sort()).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'd1', 'd2']);
    expect(fake.queryCalls() - before).toBeGreaterThan(1);

    const openOnPage = await repos.bindings.listByPage('P1', ['CURRENT']);
    expect(openOnPage.map((b) => b.id).sort()).toEqual(['b1', 'b3', 'b5', 'b7', 'd1']);

    const onIssue = await repos.bindings.listByIssue('OPS-SHARED');
    expect(onIssue.map((b) => b.id).sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'd1', 'd2']);

    const pages = await repos.procedures.listWithOpenBindings();
    expect(pages.sort()).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']);
  });

  it('uses only keys that match the allowed pattern', async () => {
    const fake = createFakeKvs(2);
    const repos = createKvsRepos(fake.store);
    await repos.procedures.put({
      pageId: '12345',
      title: 'Procedure',
      controlled: true,
      policy: 'approved-only',
      approved: [{ version: 1, approvedBy: 'alice', approvedAt: '2026-01-01T00:00:00Z', bodyHash: 'h1', minorEdit: false }],
      currentApproved: 1,
      lastSeenVersion: 1,
    });
    await repos.snapshots.put({ pageId: '12345', version: 1, bodyHash: 'h1', nodes: [] });
    await repos.bindings.put(binding('bind-1_a.b#c', 'OPS-1', '12345', 'CURRENT'));
    await repos.deltas.put({
      pageId: '12345',
      fromVersion: 1,
      toVersion: 2,
      items: [],
      fromHash: 'a',
      toHash: 'b',
      engineVersion: '1.0.0',
    });
    await repos.attestations.put({ bindingId: 'bind-1_a.b#c', toVersion: 2, items: [], implementer: 'carol' });
    for (let seq = 1; seq <= 3; seq++) {
      await repos.audit.append({
        issueKey: 'OPS-1',
        seq,
        type: 'BOUND',
        actor: 'bob',
        at: '2026-01-01T00:00:00Z',
        payload: {},
        prevHash: 'genesis',
        hash: `h${seq}`,
      });
    }
    await repos.settings.put({ revisionPolicy: 'every-major', validatorMode: 'warn', autoBind: { 'OPS-PROJECT': '12345' }, requireIndependentApprover: true });
    await repos.procedures.listWithOpenBindings();
    await repos.bindings.listByIssue('OPS-1');
    await repos.audit.list('OPS-1');

    const keys = fake.keys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toMatch(KEY_PATTERN);
    }
    expect(keys).toEqual(expect.arrayContaining(['settings', 'proc:12345', 'snap:12345:1', 'auditlast:OPS-1', 'audit:OPS-1:00000003']));
  });
});
