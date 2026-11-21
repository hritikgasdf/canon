import type {
  Attestation,
  AuditEvent,
  Binding,
  BindingState,
  Delta,
  Procedure,
  SampleState,
  Settings,
  Snapshot,
} from './types';

/** Upper bound on how many controlled procedures listControlled returns. */
export const CONTROLLED_LIST_CAP = 200;

export interface ProcedureRepo {
  get(pageId: string): Promise<Procedure | null>;
  put(p: Procedure): Promise<void>;
  /** pageIds that have at least one non-closed (no closedAt) binding in CURRENT, SUPERSEDED or REATTESTING. */
  listWithOpenBindings(): Promise<string[]>;
  /** Procedures with controlled === true, at most CONTROLLED_LIST_CAP. */
  listControlled(): Promise<Procedure[]>;
}

export interface SnapshotRepo {
  get(pageId: string, version: number): Promise<Snapshot | null>;
  put(s: Snapshot): Promise<void>;
}

export interface BindingRepo {
  get(id: string): Promise<Binding | null>;
  put(b: Binding): Promise<void>;
  listByIssue(issueKey: string): Promise<Binding[]>;
  listByPage(pageId: string, states?: BindingState[]): Promise<Binding[]>;
}

export interface DeltaRepo {
  get(pageId: string, from: number, to: number): Promise<Delta | null>;
  put(d: Delta): Promise<void>;
}

export interface AttestationRepo {
  get(bindingId: string, toVersion: number): Promise<Attestation | null>;
  put(a: Attestation): Promise<void>;
}

export interface AuditRepo {
  last(issueKey: string): Promise<AuditEvent | null>;
  append(e: AuditEvent): Promise<void>;
  /** Ordered by seq ascending. */
  list(issueKey: string): Promise<AuditEvent[]>;
}

export interface SettingsRepo {
  get(): Promise<Settings>;
  put(s: Settings): Promise<void>;
}

export interface SampleStateRepo {
  get(): Promise<SampleState | null>;
  put(s: SampleState): Promise<void>;
}

export interface Repos {
  procedures: ProcedureRepo;
  snapshots: SnapshotRepo;
  bindings: BindingRepo;
  deltas: DeltaRepo;
  attestations: AttestationRepo;
  audit: AuditRepo;
  settings: SettingsRepo;
  sample: SampleStateRepo;
}
