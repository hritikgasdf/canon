// Break-glass override: a project admin accepts the risk of a superseded/orphaned binding.
// The override covers only the version known at the time; a newer revision blocks again.
// No @forge/* imports. Actor and admin status are supplied by the (server-side) caller.
import { appendAudit } from './audit';
import type { Repos } from './repos';
import type { Binding } from './types';

export type OverrideErrorCode = 'NOT_FOUND' | 'NOT_ADMIN' | 'REASON_REQUIRED' | 'NOT_BLOCKED' | 'ALREADY_OVERRIDDEN';

export class OverrideError extends Error {
  readonly code: OverrideErrorCode;
  constructor(code: OverrideErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'OverrideError';
    this.code = code;
  }
}

import { REASON_MIN, REASON_MAX } from './limits';
export { REASON_MIN, REASON_MAX };

export async function breakGlass(
  repos: Repos,
  p: {
    issueKey: string;
    bindingId: string;
    actor: string;
    at: string;
    reason: string;
    isProjectAdmin: boolean;
  },
): Promise<Binding> {
  const b = await repos.bindings.get(p.bindingId);
  if (!b || b.issueKey !== p.issueKey) throw new OverrideError('NOT_FOUND', 'No such binding on this issue.');
  if (p.isProjectAdmin !== true) {
    throw new OverrideError('NOT_ADMIN', 'Only project administrators can override the gate.');
  }
  const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    throw new OverrideError('REASON_REQUIRED', `A reason of ${REASON_MIN} to ${REASON_MAX} characters is required.`);
  }
  if (b.state !== 'SUPERSEDED' && b.state !== 'REATTESTING' && b.state !== 'ORPHANED') {
    throw new OverrideError('NOT_BLOCKED', `Binding is ${b.state}; there is nothing to override.`);
  }

  const proc = await repos.procedures.get(b.pageId);
  const forVersion = b.supersededBy ?? proc?.currentApproved ?? null;
  if (b.override && (b.override.forVersion === forVersion || (b.state === 'ORPHANED' && b.override.priorState === 'ORPHANED'))) {
    throw new OverrideError('ALREADY_OVERRIDDEN', 'This binding already has an override covering the current version.');
  }

  const next: Binding = { ...b, override: { by: p.actor, at: p.at, reason, forVersion, priorState: b.state } };
  // Audit first: if this throws, the binding is untouched and the gate keeps blocking.
  await appendAudit(repos.audit, {
    issueKey: b.issueKey,
    type: 'BREAK_GLASS',
    actor: p.actor,
    at: p.at,
    payload: { bindingId: b.id, reason, forVersion, priorState: b.state },
  });
  try {
    await repos.bindings.put(next);
  } catch (e) {
    try {
      await appendAudit(repos.audit, {
        issueKey: b.issueKey,
        type: 'BREAK_GLASS_FAILED',
        actor: p.actor,
        at: p.at,
        payload: { bindingId: b.id, reason, forVersion, priorState: b.state },
      });
    } catch {
      // best effort
    }
    throw e;
  }
  return next;
}
