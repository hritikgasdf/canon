// Handler for the canonBreakGlass resolver. No @forge/* imports: tests pass fakes.
// Actor is ALWAYS context.accountId; admin status is decided server-side via deps.isProjectAdmin.
// Anything in the payload other than bindingId and reason is ignored.
import { breakGlass, OverrideError } from '../domain/override';
import type { Repos } from '../domain/repos';

export type OverrideResponse =
  | { ok: true; overridden: true }
  | { ok: false; error: string; message: string };

export interface OverrideDeps {
  repos: Repos;
  canView(pageId: string): Promise<boolean>;
  isProjectAdmin(projectKey: string): Promise<boolean>;
  now: () => string;
}

type Req = {
  context?: {
    accountId?: string;
    extension?: { issue?: { key?: string }; project?: { key?: string } };
  };
  payload?: unknown;
};

export async function breakGlassHandler(req: unknown, deps: OverrideDeps): Promise<OverrideResponse> {
  try {
    const r = (req ?? {}) as Req;
    const issueKey = r.context?.extension?.issue?.key;
    const actor = r.context?.accountId;
    if (!issueKey || !actor) return { ok: false, error: 'NO_CONTEXT', message: 'Missing issue or user context.' };

    const payload = (r.payload && typeof r.payload === 'object' ? r.payload : {}) as Record<string, unknown>;
    const { bindingId, reason } = payload;
    if (typeof bindingId !== 'string' || bindingId === '') {
      return { ok: false, error: 'INVALID_INPUT', message: 'payload.bindingId must be a non-empty string.' };
    }
    const binding = await deps.repos.bindings.get(bindingId);
    if (!binding || binding.issueKey !== issueKey) {
      return { ok: false, error: 'NOT_FOUND', message: 'No such binding on this issue.' };
    }
    if (!(await deps.canView(binding.pageId))) {
      return { ok: false, error: 'NO_ACCESS', message: 'You do not have access to this page.' };
    }

    const projectKey = r.context?.extension?.project?.key ?? issueKey.slice(0, issueKey.lastIndexOf('-'));
    let isAdmin = false;
    try {
      isAdmin = (await deps.isProjectAdmin(projectKey)) === true;
    } catch {
      isAdmin = false; // fail closed
    }

    await breakGlass(deps.repos, {
      issueKey,
      bindingId,
      actor,
      at: deps.now(),
      reason: typeof reason === 'string' ? reason : '',
      isProjectAdmin: isAdmin,
    });
    return { ok: true, overridden: true };
  } catch (e) {
    if (e instanceof OverrideError) return { ok: false, error: e.code, message: e.message };
    return { ok: false, error: 'INTERNAL', message: e instanceof Error ? e.message : 'Unexpected error' };
  }
}
