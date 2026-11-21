import type { Repos } from './repos';
import { ensureSnapshot, supersede, type BodyFetcher, type SupersedeResult } from './supersede';
import type { BindingState, Procedure, RevisionPolicy } from './types';

export type PageMeta = {
  pageId: string;
  title: string;
  spaceKey?: string;
  currentVersion: number;
  lastEditorId: string;
  minorEdit: boolean;
};

export type ApproveErrorCode = 'NOT_CONTROLLED' | 'STALE_VERSION' | 'ALREADY_APPROVED' | 'SELF_APPROVAL' | 'NOT_LATEST';

export class ApproveError extends Error {
  code: ApproveErrorCode;
  constructor(code: ApproveErrorCode, message: string) {
    super(message);
    this.name = 'ApproveError';
    this.code = code;
  }
}

const OPEN_STATES: BindingState[] = ['CURRENT', 'SUPERSEDED', 'REATTESTING'];

export async function markControlled(
  repos: Repos,
  meta: PageMeta,
  input: { actor: string; at: string; policy?: RevisionPolicy },
): Promise<Procedure> {
  const existing = await repos.procedures.get(meta.pageId);
  if (existing?.controlled) return existing;
  const settings = await repos.settings.get();
  const procedure: Procedure = {
    ...(existing ?? {
      pageId: meta.pageId,
      title: meta.title,
      policy: input.policy ?? settings.revisionPolicy,
      approved: [],
      currentApproved: null,
    }),
    controlled: true,
    lastSeenVersion: existing?.lastSeenVersion ?? meta.currentVersion,
  };
  if (meta.spaceKey !== undefined) procedure.spaceKey = meta.spaceKey;
  await repos.procedures.put(procedure);
  return procedure;
}

export async function approveVersion(
  repos: Repos,
  fetchBody: BodyFetcher,
  meta: PageMeta,
  input: { version: number; actor: string; at: string; isIssueOpen?: (k: string) => Promise<boolean> },
): Promise<{ procedure: Procedure; supersede: SupersedeResult | null }> {
  const { version, actor, at, isIssueOpen } = input;
  const proc = await repos.procedures.get(meta.pageId);
  if (!proc || !proc.controlled) throw new ApproveError('NOT_CONTROLLED', 'This page is not a controlled procedure.');
  if (version !== meta.currentVersion) {
    throw new ApproveError('NOT_LATEST', `Version ${version} is not the latest (${meta.currentVersion}).`);
  }
  const previous = proc.currentApproved;
  if (previous !== null) {
    if (version === previous) throw new ApproveError('ALREADY_APPROVED', `Version ${version} is already approved.`);
    if (version < previous) {
      throw new ApproveError('STALE_VERSION', `Version ${version} is older than approved version ${previous}.`);
    }
  }
  const settings = await repos.settings.get();
  if (settings.requireIndependentApprover && actor === meta.lastEditorId) {
    throw new ApproveError('SELF_APPROVAL', 'The last editor cannot approve their own changes.');
  }

  const snap = await ensureSnapshot(repos, fetchBody, meta.pageId, version);
  const procedure: Procedure = {
    ...proc,
    approved: [
      ...proc.approved,
      { version, approvedBy: actor, approvedAt: at, bodyHash: snap.bodyHash, minorEdit: meta.minorEdit },
    ],
    currentApproved: version,
    lastSeenVersion: Math.max(proc.lastSeenVersion ?? 0, version),
  };
  await repos.procedures.put(procedure);

  const result =
    previous === null
      ? null
      : await supersede(repos, fetchBody, {
          pageId: meta.pageId,
          toVersion: version,
          actor,
          at,
          ...(isIssueOpen ? { isIssueOpen } : {}),
        });
  return { procedure, supersede: result };
}

export async function procedureState(
  repos: Repos,
  pageId: string,
): Promise<{ procedure: Procedure | null; openBindings: number; pendingDraft: boolean }> {
  const procedure = await repos.procedures.get(pageId);
  const open = await repos.bindings.listByPage(pageId, OPEN_STATES);
  const pendingDraft =
    procedure !== null && procedure.lastSeenVersion !== null && procedure.lastSeenVersion > (procedure.currentApproved ?? 0);
  return { procedure, openBindings: open.length, pendingDraft };
}
