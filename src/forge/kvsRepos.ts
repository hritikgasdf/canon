import kvs, { WhereConditions, type BeginsWithClause } from '@forge/kvs';
import { withIssueSync } from '../domain/syncedRepos';
import { putCanonGateProperty } from './issueProperty';
import {
  CONTROLLED_LIST_CAP,
  type AttestationRepo,
  type AuditRepo,
  type BindingRepo,
  type DeltaRepo,
  type ProcedureRepo,
  type Repos,
  type SettingsRepo,
  type SnapshotRepo,
} from '../domain/repos';
import {
  DEFAULT_SETTINGS,
  type Attestation,
  type AuditEvent,
  type Binding,
  type BindingState,
  type Delta,
  type Procedure,
  type Settings,
  type Snapshot,
} from '../domain/types';

/** The subset of the Forge KVS query builder used here. Satisfied by `kvs.query()`. */
export interface KvsQueryLike {
  where(property: 'key', condition: BeginsWithClause): KvsQueryLike;
  cursor(cursor: string): KvsQueryLike;
  limit(limit: number): KvsQueryLike;
  getMany<T>(): Promise<{ results: { key: string; value: T }[]; nextCursor?: string }>;
}

/** The subset of the Forge KVS API used here. Satisfied by the default `kvs` export. */
export interface KvsStoreLike {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<unknown>;
  delete(key: string): Promise<void>;
  query(): KvsQueryLike;
}

const KEY_PATTERN = /^[a-zA-Z0-9:._#-]+$/;
/** Id segments may not contain ':' so that prefix queries cannot collide. */
const SEGMENT_PATTERN = /^[a-zA-Z0-9._#-]+$/;
const PAGE_SIZE = 100;
const OPEN_STATES: readonly BindingState[] = ['CURRENT', 'SUPERSEDED', 'REATTESTING'];

function segment(value: string | number): string {
  const s = String(value);
  if (!SEGMENT_PATTERN.test(s)) throw new Error(`Invalid KVS key segment: ${JSON.stringify(s)}`);
  return s;
}

function keyOf(...parts: (string | number)[]): string {
  const key = parts.map(segment).join(':');
  // Unreachable for valid segments; kept as a guard so a bad key fails loudly, never silently.
  if (!KEY_PATTERN.test(key)) throw new Error(`Invalid KVS key: ${key}`);
  return key;
}

function padSeq(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= 1e8) {
    throw new Error(`Audit seq out of range: ${seq}`);
  }
  return String(seq).padStart(8, '0');
}

/** Loads every entry under a key prefix, following nextCursor until exhausted. */
async function queryAll<T>(store: KvsStoreLike, prefix: string): Promise<{ key: string; value: T }[]> {
  const out: { key: string; value: T }[] = [];
  let cursor: string | undefined;
  do {
    let q = store.query().where('key', WhereConditions.beginsWith(prefix)).limit(PAGE_SIZE);
    if (cursor !== undefined) q = q.cursor(cursor);
    const page = await q.getMany<T>();
    out.push(...page.results);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

function bindingKey(id: string): string {
  return keyOf('bind', id);
}

function createProcedureRepo(store: KvsStoreLike, loadBinding: (id: string) => Promise<Binding | null>): ProcedureRepo {
  return {
    async get(pageId) {
      return (await store.get<Procedure>(keyOf('proc', pageId))) ?? null;
    },
    async put(p) {
      await store.set(keyOf('proc', p.pageId), p);
    },
    async listWithOpenBindings() {
      const pageIds = new Set<string>();
      const entries = await queryAll<string>(store, 'bpx:');
      for (const entry of entries) {
        const bindingId = entry.value;
        const b = await loadBinding(bindingId);
        if (b === null || pageIds.has(b.pageId)) continue;
        if (OPEN_STATES.includes(b.state)) pageIds.add(b.pageId);
      }
      return [...pageIds];
    },
    async listControlled() {
      // Page through the proc: prefix, keeping only controlled procedures. Stop as soon as the
      // cap is reached so a large site never triggers an unbounded scan.
      const out: Procedure[] = [];
      let cursor: string | undefined;
      do {
        let q = store.query().where('key', WhereConditions.beginsWith('proc:')).limit(PAGE_SIZE);
        if (cursor !== undefined) q = q.cursor(cursor);
        const page = await q.getMany<Procedure>();
        for (const entry of page.results) {
          if (entry.value.controlled === true) out.push(entry.value);
          if (out.length >= CONTROLLED_LIST_CAP) return out;
        }
        cursor = page.nextCursor;
      } while (cursor);
      return out;
    },
  };
}

function createSnapshotRepo(store: KvsStoreLike): SnapshotRepo {
  return {
    async get(pageId, version) {
      return (await store.get<Snapshot>(keyOf('snap', pageId, version))) ?? null;
    },
    async put(s) {
      await store.set(keyOf('snap', s.pageId, s.version), s);
    },
  };
}

function createBindingRepo(store: KvsStoreLike): BindingRepo & { load(id: string): Promise<Binding | null> } {
  const load = async (id: string): Promise<Binding | null> =>
    (await store.get<Binding>(bindingKey(id))) ?? null;

  const loadAll = async (entries: { value: string }[]): Promise<Binding[]> => {
    const out: Binding[] = [];
    for (const entry of entries) {
      const b = await load(entry.value);
      if (b !== null) out.push(b);
    }
    return out;
  };

  return {
    load,
    async get(id) {
      return load(id);
    },
    async put(b) {
      // If a binding is re-written under a different issue or page, drop the stale index keys.
      const previous = await load(b.id);
      if (previous !== null) {
        if (previous.issueKey !== b.issueKey) await store.delete(keyOf('bix', previous.issueKey, b.id));
        if (previous.pageId !== b.pageId) await store.delete(keyOf('bpx', previous.pageId, b.id));
      }
      await store.set(bindingKey(b.id), b);
      await store.set(keyOf('bix', b.issueKey, b.id), b.id);
      await store.set(keyOf('bpx', b.pageId, b.id), b.id);
    },
    async listByIssue(issueKey) {
      return loadAll(await queryAll<string>(store, `bix:${segment(issueKey)}:`));
    },
    async listByPage(pageId, states) {
      const all = await loadAll(await queryAll<string>(store, `bpx:${segment(pageId)}:`));
      return states === undefined ? all : all.filter((b) => states.includes(b.state));
    },
  };
}

function createDeltaRepo(store: KvsStoreLike): DeltaRepo {
  return {
    async get(pageId, from, to) {
      return (await store.get<Delta>(keyOf('delta', pageId, from, to))) ?? null;
    },
    async put(d) {
      await store.set(keyOf('delta', d.pageId, d.fromVersion, d.toVersion), d);
    },
  };
}

function createAttestationRepo(store: KvsStoreLike): AttestationRepo {
  return {
    async get(bindingId, toVersion) {
      return (await store.get<Attestation>(keyOf('att', bindingId, toVersion))) ?? null;
    },
    async put(a) {
      await store.set(keyOf('att', a.bindingId, a.toVersion), a);
    },
  };
}

function createAuditRepo(store: KvsStoreLike): AuditRepo {
  return {
    async last(issueKey) {
      return (await store.get<AuditEvent>(keyOf('auditlast', issueKey))) ?? null;
    },
    async append(e) {
      await store.set(keyOf('audit', e.issueKey, padSeq(e.seq)), e);
      const current = await store.get<AuditEvent>(keyOf('auditlast', e.issueKey));
      if (current === undefined || e.seq > current.seq) {
        await store.set(keyOf('auditlast', e.issueKey), e);
      }
    },
    async list(issueKey) {
      const entries = await queryAll<AuditEvent>(store, `audit:${segment(issueKey)}:`);
      return entries.map((x) => x.value).sort((x, y) => x.seq - y.seq);
    },
  };
}

function createSettingsRepo(store: KvsStoreLike): SettingsRepo {
  return {
    async get() {
      const stored = await store.get<Settings>('settings');
      // Merge over defaults so settings stored before a field existed get the safe default.
      return { ...structuredClone(DEFAULT_SETTINGS), ...stored };
    },
    async put(s) {
      await store.set('settings', s);
    },
  };
}

/**
 * Forge KVS-backed implementation of the domain repos. Uses only plain key/value
 * reads, writes and key-prefix queries; no Custom Entities.
 */
export function createKvsRepos(store: KvsStoreLike = kvs): Repos {
  const bindings = createBindingRepo(store);
  return {
    procedures: createProcedureRepo(store, bindings.load),
    snapshots: createSnapshotRepo(store),
    bindings,
    deltas: createDeltaRepo(store),
    attestations: createAttestationRepo(store),
    audit: createAuditRepo(store),
    settings: createSettingsRepo(store),
  };
}

/** Production repos: KVS-backed, with every binding write mirrored to the canon.gate issue property. */
export function createAppRepos(): Repos {
  return withIssueSync(createKvsRepos(), putCanonGateProperty, console.log);
}
