// Read-only Rovo actions on the real Canon data. Pure domain logic: no @forge/* imports.
// The issue key is trusted context from the caller; nothing here authorises from model inputs.
import type { PageMeta } from './approve';
import { GATE_FAIL_CLOSED } from './gateEval';
import { runCanonGate } from './gateRun';
import { getBindingDelta, type DeltaCounts } from './issueDelta';
import type { Repos } from './repos';
import { ensureSnapshot, type BodyFetcher } from './supersede';
import type { BindingState, DeltaHint, DeltaKind, StepNode } from './types';

export interface RovoDeps {
  repos: Repos;
  getPageMeta(pageId: string): Promise<PageMeta>;
  fetchBody: BodyFetcher;
  canView(pageId: string): Promise<boolean>;
  now(): string;
}

export const APPROVED_NODE_CAP = 200;

export type RovoOverall = 'NO_BINDING' | 'CLEAR' | 'BLOCKED' | 'WARN_ONLY' | 'UNVERIFIED';
export type RovoBindingState = BindingState | 'UNVERIFIED';

export interface RovoBindingStatus {
  bindingId: string;
  state: RovoBindingState;
  boundVersion: number;
  targetVersion?: number;
  openItems?: number;
  title?: string;
  restricted: boolean;
}

export type RovoGateStatus = {
  ok: true;
  issueKey: string;
  overall: RovoOverall;
  bindings?: RovoBindingStatus[];
  message: string;
};

export type RovoFailure = { ok: false; error: string; message: string };

async function visible(deps: RovoDeps, pageId: string): Promise<boolean> {
  try {
    return (await deps.canView(pageId)) === true;
  } catch {
    return false; // fail closed
  }
}

export async function rovoGateStatus(issueKey: string, deps: RovoDeps): Promise<RovoGateStatus> {
  try {
    const decision = await runCanonGate(issueKey, deps);
    if (decision.bindingCount === 0) {
      return {
        ok: true,
        issueKey,
        overall: 'NO_BINDING',
        bindings: [],
        message: 'This work item is not bound to a Confluence procedure.',
      };
    }
    const bindings = await deps.repos.bindings.listByIssue(issueKey);
    const out: RovoBindingStatus[] = [];
    for (const b of bindings) {
      const canView = await visible(deps, b.pageId);
      const satisfiedAt = b.state === 'CLEARED' ? (b.supersededBy ?? b.boundVersion) : b.boundVersion;
      const reason = decision.reasons.find((r) => r.pageId === b.pageId && r.boundVersion === satisfiedAt);
      const entry: RovoBindingStatus = {
        bindingId: b.id,
        state: reason && reason.code !== 'PENDING_APPROVAL_IGNORED' ? reason.code : b.state,
        boundVersion: b.boundVersion,
        restricted: !canView,
      };
      if (canView) {
        if (reason?.targetVersion !== undefined) entry.targetVersion = reason.targetVersion;
        if (reason?.openItems !== undefined) entry.openItems = reason.openItems;
        const title = reason?.title ?? (await deps.repos.procedures.get(b.pageId))?.title;
        if (title !== undefined) entry.title = title;
      }
      out.push(entry);
    }
    const overall: RovoOverall = !decision.allow ? 'BLOCKED' : decision.warnOnly ? 'WARN_ONLY' : 'CLEAR';
    const message =
      overall === 'CLEAR'
        ? 'All bound procedures are at their current approved version (or re-attested). Done is not blocked.'
        : (decision.message ?? GATE_FAIL_CLOSED);
    return { ok: true, issueKey, overall, bindings: out, message };
  } catch {
    return { ok: true, issueKey, overall: 'UNVERIFIED', message: GATE_FAIL_CLOSED };
  }
}

export interface RovoDeltaItem {
  itemId: string;
  kind: DeltaKind;
  path: string[];
  before: string | null;
  after: string | null;
  hints: DeltaHint[];
  trivial: boolean;
}

export type RovoDeltaBinding =
  | { bindingId: string; restricted: true }
  | {
      bindingId: string;
      restricted: false;
      title: string;
      fromVersion: number;
      toVersion: number | null;
      items: RovoDeltaItem[];
      counts: DeltaCounts;
      materialCount: number;
    };

export async function rovoExplainDelta(
  issueKey: string,
  deps: RovoDeps,
): Promise<{ ok: true; issueKey: string; bindings: RovoDeltaBinding[]; message: string }> {
  const bindings = await deps.repos.bindings.listByIssue(issueKey);
  const out: RovoDeltaBinding[] = [];
  for (const b of bindings) {
    if (!(await visible(deps, b.pageId))) {
      out.push({ bindingId: b.id, restricted: true });
      continue;
    }
    if (b.state !== 'SUPERSEDED' && b.state !== 'REATTESTING') continue;
    const d = await getBindingDelta(deps.repos, deps.fetchBody, { issueKey, bindingId: b.id });
    out.push({
      bindingId: b.id,
      restricted: false,
      title: d.title,
      fromVersion: d.fromVersion,
      toVersion: d.toVersion,
      items: d.items.map((i) => ({
        itemId: i.itemId,
        kind: i.kind,
        path: i.path,
        before: i.before,
        after: i.after,
        hints: i.hints,
        trivial: i.trivial,
      })),
      counts: d.counts,
      materialCount: d.materialCount,
    });
  }
  const shown = out.filter((x) => !x.restricted).length;
  return {
    ok: true,
    issueKey,
    bindings: out,
    message:
      shown === 0
        ? 'No bound procedure needs re-attestation (or the procedure is restricted to you).'
        : 'Changes since this work item was bound are listed per binding.',
  };
}

export interface RovoApprovedNode {
  path: string[];
  text: string;
}

export type RovoApprovedBinding =
  | { bindingId: string; restricted: true }
  | {
      bindingId: string;
      restricted: false;
      title: string;
      version: number | null;
      nodes: RovoApprovedNode[];
      truncated: boolean;
    };

function flatten(nodes: StepNode[], acc: RovoApprovedNode[], cap: number): boolean {
  for (const n of nodes) {
    if (acc.length >= cap) return true;
    acc.push({ path: n.path, text: n.text });
    if (n.children && flatten(n.children, acc, cap)) return true;
  }
  return false;
}

export async function rovoApprovedProcedure(
  issueKey: string,
  requestedVersion: number | undefined,
  deps: RovoDeps,
): Promise<{ ok: true; issueKey: string; bindings: RovoApprovedBinding[]; message: string } | RovoFailure> {
  const bindings = await deps.repos.bindings.listByIssue(issueKey);
  const out: RovoApprovedBinding[] = [];
  for (const b of bindings) {
    if (!(await visible(deps, b.pageId))) {
      out.push({ bindingId: b.id, restricted: true });
      continue;
    }
    const proc = await deps.repos.procedures.get(b.pageId);
    const current = proc?.currentApproved ?? null;
    if (proc === null || current === null) {
      out.push({ bindingId: b.id, restricted: false, title: proc?.title ?? '', version: null, nodes: [], truncated: false });
      continue;
    }
    if (requestedVersion !== undefined && requestedVersion !== current) {
      const kind = requestedVersion < current ? 'superseded' : 'a draft that is not approved';
      return {
        ok: false,
        error: 'NOT_APPROVED_VERSION',
        message: `Version ${requestedVersion} is ${kind}; the current approved version is ${current}. Only the current approved version can be shown.`,
      };
    }
    const snap = (await deps.repos.snapshots.get(b.pageId, current)) ?? (await ensureSnapshot(deps.repos, deps.fetchBody, b.pageId, current));
    const nodes: RovoApprovedNode[] = [];
    const truncated = flatten(snap.nodes, nodes, APPROVED_NODE_CAP);
    out.push({ bindingId: b.id, restricted: false, title: proc.title, version: current, nodes, truncated });
  }
  return { ok: true, issueKey, bindings: out, message: 'Text of the current approved procedure version.' };
}
