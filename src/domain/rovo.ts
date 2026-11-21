// Read-only Rovo actions on the real Canon data. Pure domain logic: no @forge/* imports.
// The issue key is trusted context from the caller; nothing here authorises from model inputs.
import type { PageMeta } from './approve';
import { assignChecker, AttestError, setRovoTasks } from './attest';
import { getAttestation, startReattestation } from './attestService';
import { appendAudit } from './audit';
import { GATE_FAIL_CLOSED } from './gateEval';
import { runCanonGate } from './gateRun';
import { getBindingDelta, type DeltaCounts } from './issueDelta';
import type { Repos } from './repos';
import { ensureSnapshot, type BodyFetcher } from './supersede';
import type { Binding, BindingState, DeltaHint, DeltaKind, StepNode } from './types';

export interface RovoDeps {
  repos: Repos;
  getPageMeta(pageId: string): Promise<PageMeta>;
  fetchBody: BodyFetcher;
  canView(pageId: string): Promise<boolean>;
  now(): string;
}

export const APPROVED_NODE_CAP = 200;

export type RovoOverall = 'NO_BINDING' | 'CLEAR' | 'BLOCKED' | 'WARN_ONLY' | 'UNVERIFIED';
export type RovoBindingState = BindingState | 'UNVERIFIED' | 'CLOSED';

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
        state:
          b.closedAt !== undefined
            ? 'CLOSED'
            : reason && reason.code !== 'PENDING_APPROVAL_IGNORED'
              ? reason.code
              : b.state,
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

// ---- Write-side actions: actor and issue key are trusted context; inputs never authorise. ----

export interface RovoWriteDeps extends RovoDeps {
  canUserBrowseIssue(accountId: string, issueKey: string): Promise<boolean>;
}

const MAX_CHECKLIST_ITEMS = 200;
const CHECKER_ID = /^[A-Za-z0-9:_-]{6,128}$/;

const fail = (error: string, message: string): RovoFailure => ({ ok: false, error, message });

function parseJson(s: unknown): unknown {
  if (typeof s !== 'string') throw new Error('not a string');
  return JSON.parse(s) as unknown;
}

function parseChecklistInput(itemIdsJson: unknown, tasksJson: unknown): { itemId: string; task: string }[] | null {
  try {
    const ids = parseJson(itemIdsJson);
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_CHECKLIST_ITEMS) return null;
    if (!ids.every((x) => typeof x === 'string' && x !== '')) return null;
    const itemIds = ids as string[];
    if (new Set(itemIds).size !== itemIds.length) return null;
    const tasks = parseJson(tasksJson);
    let texts: unknown[];
    if (Array.isArray(tasks)) {
      if (tasks.length !== itemIds.length) return null;
      texts = tasks;
    } else if (tasks !== null && typeof tasks === 'object') {
      const m = tasks as Record<string, unknown>;
      texts = itemIds.map((id) => (Object.prototype.hasOwnProperty.call(m, id) ? m[id] : undefined));
    } else return null;
    const out: { itemId: string; task: string }[] = [];
    for (let i = 0; i < itemIds.length; i++) {
      const t = texts[i];
      if (typeof t !== 'string') return null;
      const task = t.trim();
      if (task.length < 1 || task.length > 500) return null;
      out.push({ itemId: itemIds[i] as string, task });
    }
    return out;
  } catch {
    return null;
  }
}

type Picked = { ok: true; binding: Binding } | RovoFailure;

async function pickBinding(
  deps: RovoDeps,
  issueKey: string,
  bindingId: string | undefined,
  needs: (b: Binding) => boolean,
): Promise<Picked> {
  const all = await deps.repos.bindings.listByIssue(issueKey);
  let b: Binding | undefined;
  if (bindingId !== undefined && bindingId !== '') {
    b = all.find((x) => x.id === bindingId); // must belong to this issue
    if (!b) return fail('NOT_FOUND', 'No such binding on this work item.');
  } else {
    const cands = all.filter(needs);
    if (cands.length === 0) return fail('NOTHING_TO_ATTEST', 'No bound procedure needs re-attestation.');
    if (cands.length > 1) return fail('AMBIGUOUS_BINDING', 'More than one binding needs re-attestation; give a bindingId.');
    b = cands[0];
  }
  if (!b || !(await visible(deps, b.pageId))) return fail('RESTRICTED', 'This procedure is restricted to you.');
  return { ok: true, binding: b };
}

const needsReattest = (b: Binding): boolean => b.state === 'SUPERSEDED' || b.state === 'REATTESTING';

function failFrom(e: unknown): RovoFailure {
  if (e instanceof AttestError) return fail(e.code, e.message);
  return fail('INTERNAL', 'Unexpected error');
}

export async function rovoCreateChecklist(
  issueKey: string,
  actor: string,
  input: { bindingId?: string; itemIdsJson: unknown; tasksJson: unknown },
  deps: RovoWriteDeps,
): Promise<
  | {
      ok: true;
      bindingId: string;
      toVersion: number;
      items: { itemId: string; status: string; rovoTask?: string }[];
      implementer: string;
    }
  | RovoFailure
> {
  try {
    const parsed = parseChecklistInput(input.itemIdsJson, input.tasksJson);
    if (parsed === null) {
      return fail('BAD_INPUT', 'itemIdsJson and tasksJson must be matching JSON arrays (or tasks an object keyed by item id) of non-empty strings.');
    }
    const picked = await pickBinding(deps, issueKey, input.bindingId, needsReattest);
    if (!picked.ok) return picked;
    const b = picked.binding;
    const ref = { issueKey, bindingId: b.id };

    if ((await getAttestation(deps.repos, ref)) === null) {
      // Validate against the delta first so a bad item id starts nothing.
      const d = await getBindingDelta(deps.repos, deps.fetchBody, ref);
      const known = new Set(d.items.filter((i) => !i.trivial).map((i) => i.itemId));
      if (parsed.some((t) => !known.has(t.itemId))) return fail('UNKNOWN_ITEM', 'One or more item ids are not in the delta.');
    }
    const att = await startReattestation(deps.repos, deps.fetchBody, { ...ref, actor, at: deps.now() });
    if (parsed.some((t) => !att.items.some((i) => i.itemId === t.itemId))) {
      return fail('UNKNOWN_ITEM', 'One or more item ids are not in the attestation.');
    }
    const next = setRovoTasks(att, parsed);
    const changed = next.items.some((it, i) => it.rovoTask !== att.items[i]?.rovoTask);
    if (changed) {
      await deps.repos.attestations.put(next);
      await appendAudit(deps.repos.audit, {
        issueKey,
        type: 'ROVO_TASKS_SET',
        actor,
        at: deps.now(),
        payload: { bindingId: b.id, itemIds: parsed.map((t) => t.itemId) },
      });
    }
    return {
      ok: true,
      bindingId: b.id,
      toVersion: next.toVersion,
      items: next.items.map((i) => ({ itemId: i.itemId, status: i.status, rovoTask: i.rovoTask })),
      implementer: next.implementer,
    };
  } catch (e) {
    return failFrom(e);
  }
}

export async function rovoAssignChecker(
  issueKey: string,
  actor: string,
  input: { bindingId?: string; checkerAccountId: unknown },
  deps: RovoWriteDeps,
): Promise<{ ok: true; checker: string } | RovoFailure> {
  try {
    const checker = input.checkerAccountId;
    if (typeof checker !== 'string' || !CHECKER_ID.test(checker)) {
      return fail('BAD_INPUT', 'checkerAccountId is not a valid account id.');
    }
    const picked = await pickBinding(deps, issueKey, input.bindingId, (b) => b.state === 'REATTESTING');
    if (!picked.ok) return picked;
    const b = picked.binding;
    const att = await getAttestation(deps.repos, { issueKey, bindingId: b.id });
    if (att === null) return fail('NOT_STARTED', 'Re-attestation has not been started.');
    if (att.implementer !== actor) return fail('NOT_IMPLEMENTER', 'Only the implementer can assign a checker.');
    const next = assignChecker(att, { checker }); // SELF_REVIEW / SEALED
    let canBrowse = false;
    try {
      canBrowse = (await deps.canUserBrowseIssue(checker, issueKey)) === true;
    } catch {
      canBrowse = false; // fail closed
    }
    if (!canBrowse) return fail('CHECKER_NO_ACCESS', 'That user cannot browse this work item.');
    if (att.checker !== checker) {
      await deps.repos.attestations.put(next);
      await appendAudit(deps.repos.audit, {
        issueKey,
        type: 'CHECKER_ASSIGNED',
        actor,
        at: deps.now(),
        payload: { bindingId: b.id, checker },
      });
    }
    return { ok: true, checker };
  } catch (e) {
    return failFrom(e);
  }
}
