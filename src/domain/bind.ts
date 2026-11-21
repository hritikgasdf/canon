import { appendAudit } from './audit';
import type { Repos } from './repos';
import type { Binding, BindingState } from './types';

export type BindErrorCode = 'NOT_CONTROLLED' | 'NO_APPROVED_VERSION' | 'ALREADY_BOUND';

/** Thrown when a bind is refused. `code` is safe to show to the user and to return from resolvers. */
export class BindError extends Error {
  code: BindErrorCode;
  constructor(code: BindErrorCode, message: string) {
    super(message);
    this.name = 'BindError';
    this.code = code;
  }
}

/** A binding in one of these states still blocks a new bind for the same issue and page. */
const BLOCKING_STATES: readonly BindingState[] = ['CURRENT', 'SUPERSEDED', 'REATTESTING'];

/**
 * Bind a Jira issue to the currently approved version of a controlled procedure.
 * The bound version is always `currentApproved`, never a draft or `lastSeenVersion`.
 * Re-binding is allowed once an earlier binding is CLEARED or ORPHANED.
 */
export async function bindIssue(
  repos: Repos,
  p: { issueKey: string; pageId: string; actor: string; at: string },
): Promise<Binding> {
  const procedure = await repos.procedures.get(p.pageId);
  if (!procedure || !procedure.controlled) {
    throw new BindError('NOT_CONTROLLED', 'This page is not a controlled procedure.');
  }
  const approved = procedure.currentApproved;
  if (approved === null) {
    throw new BindError('NO_APPROVED_VERSION', 'This procedure has no approved version to bind to.');
  }

  const id = `${p.issueKey}.${p.pageId}`;
  const existing = await repos.bindings.get(id);
  if (existing !== null && BLOCKING_STATES.includes(existing.state)) {
    throw new BindError('ALREADY_BOUND', 'This issue is already bound to this procedure.');
  }

  const binding: Binding = {
    id,
    issueKey: p.issueKey,
    pageId: p.pageId,
    boundVersion: approved,
    boundAt: p.at,
    boundBy: p.actor,
    state: 'CURRENT',
  };
  await repos.bindings.put(binding);
  await appendAudit(repos.audit, {
    issueKey: p.issueKey,
    type: 'BOUND',
    actor: p.actor,
    at: p.at,
    payload: { pageId: p.pageId, version: approved },
  });
  return binding;
}
