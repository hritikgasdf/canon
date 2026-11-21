import {
  CONTROLLED_LIST_CAP,
  type ProcedureRepo,
  type SnapshotRepo,
  type BindingRepo,
  type DeltaRepo,
  type AttestationRepo,
  type AuditRepo,
  type SettingsRepo,
  type Repos,
} from './repos';
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
} from './types';

const OPEN_STATES: readonly BindingState[] = ['CURRENT', 'SUPERSEDED', 'REATTESTING'];

/** In-memory implementations for tests and local runs. All values are deep-copied in and out. */
export function createMemoryRepos(): Repos {
  const procedures = new Map<string, Procedure>();
  const snapshots = new Map<string, Snapshot>();
  const bindings = new Map<string, Binding>();
  const deltas = new Map<string, Delta>();
  const attestations = new Map<string, Attestation>();
  const audit = new Map<string, AuditEvent[]>();
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);

  const procedureRepo: ProcedureRepo = {
    async get(pageId) {
      const p = procedures.get(pageId);
      return p === undefined ? null : structuredClone(p);
    },
    async put(p) {
      procedures.set(p.pageId, structuredClone(p));
    },
    async listWithOpenBindings() {
      const pageIds = new Set<string>();
      for (const b of bindings.values()) {
        if (OPEN_STATES.includes(b.state)) pageIds.add(b.pageId);
      }
      return [...pageIds];
    },
    async listControlled() {
      return [...procedures.values()]
        .filter((p) => p.controlled === true)
        .slice(0, CONTROLLED_LIST_CAP)
        .map((p) => structuredClone(p));
    },
  };

  const snapshotRepo: SnapshotRepo = {
    async get(pageId, version) {
      const s = snapshots.get(`${pageId}@${version}`);
      return s === undefined ? null : structuredClone(s);
    },
    async put(s) {
      snapshots.set(`${s.pageId}@${s.version}`, structuredClone(s));
    },
  };

  const bindingRepo: BindingRepo = {
    async get(id) {
      const b = bindings.get(id);
      return b === undefined ? null : structuredClone(b);
    },
    async put(b) {
      bindings.set(b.id, structuredClone(b));
    },
    async listByIssue(issueKey) {
      return [...bindings.values()]
        .filter((b) => b.issueKey === issueKey)
        .map((b) => structuredClone(b));
    },
    async listByPage(pageId, states) {
      return [...bindings.values()]
        .filter((b) => b.pageId === pageId && (states === undefined || states.includes(b.state)))
        .map((b) => structuredClone(b));
    },
  };

  const deltaRepo: DeltaRepo = {
    async get(pageId, from, to) {
      const d = deltas.get(`${pageId}|${from}|${to}`);
      return d === undefined ? null : structuredClone(d);
    },
    async put(d) {
      deltas.set(`${d.pageId}|${d.fromVersion}|${d.toVersion}`, structuredClone(d));
    },
  };

  const attestationRepo: AttestationRepo = {
    async get(bindingId, toVersion) {
      const a = attestations.get(`${bindingId}|${toVersion}`);
      return a === undefined ? null : structuredClone(a);
    },
    async put(a) {
      attestations.set(`${a.bindingId}|${a.toVersion}`, structuredClone(a));
    },
  };

  const auditRepo: AuditRepo = {
    async last(issueKey) {
      const events = audit.get(issueKey);
      if (events === undefined || events.length === 0) return null;
      return structuredClone(events[events.length - 1]);
    },
    async append(e) {
      const events = audit.get(e.issueKey) ?? [];
      events.push(structuredClone(e));
      events.sort((x, y) => x.seq - y.seq);
      audit.set(e.issueKey, events);
    },
    async list(issueKey) {
      return (audit.get(issueKey) ?? []).map((e) => structuredClone(e));
    },
  };

  const settingsRepo: SettingsRepo = {
    async get() {
      return structuredClone(settings);
    },
    async put(s) {
      settings = structuredClone(s);
    },
  };

  return {
    procedures: procedureRepo,
    snapshots: snapshotRepo,
    bindings: bindingRepo,
    deltas: deltaRepo,
    attestations: attestationRepo,
    audit: auditRepo,
    settings: settingsRepo,
  };
}
