export type BindingState = 'CURRENT' | 'SUPERSEDED' | 'REATTESTING' | 'CLEARED' | 'ORPHANED';

export type RevisionPolicy = 'approved-only' | 'every-major';

export interface ApprovedVersion {
  version: number;
  approvedBy: string;
  approvedAt: string;
  bodyHash: string;
  minorEdit: boolean;
}

export interface Procedure {
  pageId: string;
  spaceKey?: string;
  title: string;
  controlled: boolean;
  policy: RevisionPolicy;
  approved: ApprovedVersion[];
  currentApproved: number | null;
  lastSeenVersion: number | null;
  lastCheckedAt?: string;
  orphaned?: boolean;
}

export interface StepNode {
  id: string;
  path: string[];
  kind: 'section' | 'step' | 'paragraph' | 'row';
  text: string;
  children?: StepNode[];
}

export interface Snapshot {
  pageId: string;
  version: number;
  bodyHash: string;
  nodes: StepNode[];
}

export interface Binding {
  id: string;
  issueKey: string;
  issueId?: string;
  pageId: string;
  boundVersion: number;
  boundAt: string;
  boundBy: string;
  state: BindingState;
  supersededBy?: number;
  clearedAt?: string;
  override?: { by: string; at: string; reason: string; forVersion: number | null };
}

export type DeltaKind = 'ADDED' | 'REMOVED' | 'CHANGED' | 'MOVED';

export type DeltaHint = 'NUMBER' | 'DURATION' | 'ROLE' | 'MENTION' | 'MODAL' | 'APPROVER' | 'NEW_STEP';

export interface DeltaItem {
  itemId: string;
  path: string[];
  kind: DeltaKind;
  before: string | null;
  after: string | null;
  trivial: boolean;
  hints: DeltaHint[];
}

export interface Delta {
  pageId: string;
  fromVersion: number;
  toVersion: number;
  items: DeltaItem[];
  fromHash: string;
  toHash: string;
  engineVersion: string;
}

export type AttestItemStatus = 'PENDING' | 'DONE' | 'NOT_MATERIAL';

export interface AttestationItem {
  itemId: string;
  status: AttestItemStatus;
  by?: string;
  at?: string;
  note?: string;
  rovoTask?: string;
}

export interface Attestation {
  bindingId: string;
  toVersion: number;
  items: AttestationItem[];
  implementer: string;
  checker?: string;
  checkerSignedAt?: string;
  sealHash?: string;
}

export interface AuditEvent {
  issueKey: string;
  seq: number;
  type: string;
  actor: string;
  at: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface Settings {
  revisionPolicy: RevisionPolicy;
  validatorMode: 'block' | 'warn';
  autoBind: Record<string, string>;
  requireIndependentApprover: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  revisionPolicy: 'approved-only',
  validatorMode: 'block',
  autoBind: {},
  requireIndependentApprover: true,
};
