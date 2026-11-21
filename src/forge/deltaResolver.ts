// Handler body for the canonBindingDelta resolver. No @forge/* imports: the resolver wires the real
// repos, page-view check and body fetcher; tests pass fakes.
import { getBindingDelta, type BindingDeltaView } from '../domain/issueDelta';
import type { Repos } from '../domain/repos';
import type { BodyFetcher } from '../domain/supersede';

export type BindingDeltaFailure = {
  ok: false;
  error: 'NO_CONTEXT' | 'INVALID_INPUT' | 'NOT_FOUND' | 'NO_ACCESS' | 'INTERNAL';
  message: string;
};

export type BindingDeltaResponse = { ok: true; delta: BindingDeltaView } | BindingDeltaFailure;

export interface BindingDeltaDeps {
  repos: Repos;
  canView(pageId: string): Promise<boolean>;
  fetchBody: BodyFetcher;
}

type IssueReq = {
  context?: { accountId?: string; extension?: { issue?: { key?: string } } };
  payload?: unknown;
};

/**
 * Returns the delta for one binding on the current issue.
 * Order of checks: issue/user context, then payload, then binding lookup (wrong issue = NOT_FOUND),
 * then page visibility (NO_ACCESS). The page must be viewable by the user before any delta is read.
 */
export async function bindingDeltaHandler(req: unknown, deps: BindingDeltaDeps): Promise<BindingDeltaResponse> {
  try {
    const r = (req ?? {}) as IssueReq;
    const issueKey = r.context?.extension?.issue?.key;
    const accountId = r.context?.accountId;
    if (!issueKey || !accountId) return { ok: false, error: 'NO_CONTEXT', message: 'Missing issue or user context.' };

    const bindingId = (r.payload as { bindingId?: unknown } | undefined)?.bindingId;
    if (typeof bindingId !== 'string' || bindingId === '') {
      return { ok: false, error: 'INVALID_INPUT', message: 'payload.bindingId must be a non-empty string.' };
    }

    // Load the binding first so we know which page to check. A binding on another issue looks missing.
    const binding = await deps.repos.bindings.get(bindingId);
    if (!binding || binding.issueKey !== issueKey) {
      return { ok: false, error: 'NOT_FOUND', message: 'No such binding on this issue.' };
    }
    if (!(await deps.canView(binding.pageId))) {
      return { ok: false, error: 'NO_ACCESS', message: 'You do not have access to this page.' };
    }

    const delta = await getBindingDelta(deps.repos, deps.fetchBody, { issueKey, bindingId });
    return { ok: true, delta };
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') {
      return { ok: false, error: 'NOT_FOUND', message: 'No such binding on this issue.' };
    }
    console.error(JSON.stringify({ tag: 'canon-resolver-error', error: e instanceof Error ? e.message : String(e) }));
    return { ok: false, error: 'INTERNAL', message: 'Something went wrong. Try again.' };
  }
}
