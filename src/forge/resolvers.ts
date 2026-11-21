import Resolver from '@forge/resolver';
import { approveVersion, ApproveError, markControlled, procedureState } from '../domain/approve';
import { bindIssue, BindError } from '../domain/bind';
import { getBindingDelta } from '../domain/issueDelta';
import { buildIssueView } from '../domain/issueView';
import { canUserView, fetchBody, getPageMeta } from './confluence';
import { createKvsRepos } from './kvsRepos';

const resolver = new Resolver();

type Req = { context?: { accountId?: string; extension?: { content?: { id?: string } } }; payload?: unknown };
type Fail = { ok: false; error: string; message: string };

async function guarded<T extends object>(
  req: Req,
  run: (pageId: string, actor: string) => Promise<T>,
): Promise<({ ok: true } & T) | Fail> {
  try {
    const pageId = req.context?.extension?.content?.id;
    const actor = req.context?.accountId;
    if (!pageId || !actor) return { ok: false, error: 'NO_ACCESS', message: 'Missing page or user context.' };
    if (!(await canUserView(pageId))) return { ok: false, error: 'NO_ACCESS', message: 'You do not have access to this page.' };
    return { ok: true, ...(await run(pageId, actor)) };
  } catch (e) {
    if (e instanceof ApproveError) return { ok: false, error: e.code, message: e.message };
    return { ok: false, error: 'INTERNAL', message: e instanceof Error ? e.message : 'Unexpected error' };
  }
}

resolver.define('canonBylineState', (req) =>
  guarded(req as Req, async (pageId) => {
    const repos = createKvsRepos();
    const meta = await getPageMeta(pageId);
    const s = await procedureState(repos, pageId);
    return {
      procedure: s.procedure && {
        controlled: s.procedure.controlled,
        currentApproved: s.procedure.currentApproved,
        lastSeenVersion: s.procedure.lastSeenVersion,
        policy: s.procedure.policy,
      },
      openBindings: s.openBindings,
      pendingDraft: s.pendingDraft,
      liveVersion: meta.currentVersion,
    };
  }),
);

resolver.define('canonMarkControlled', (req) =>
  guarded(req as Req, async (pageId, actor) => {
    const meta = await getPageMeta(pageId);
    const procedure = await markControlled(createKvsRepos(), meta, { actor, at: new Date().toISOString() });
    return { procedure };
  }),
);

type IssueReq = {
  context?: { accountId?: string; extension?: { issue?: { key?: string } } };
  payload?: unknown;
};

resolver.define('canonIssueView', async (req) => {
  try {
    const r = req as IssueReq;
    const issueKey = r.context?.extension?.issue?.key;
    const accountId = r.context?.accountId;
    if (!issueKey || !accountId) return { ok: false, error: 'NO_ACCESS', message: 'Missing issue or user context.' };
    const view = await buildIssueView(createKvsRepos(), issueKey, { canView: canUserView });
    return { ok: true, view };
  } catch (e) {
    return { ok: false, error: 'INTERNAL', message: e instanceof Error ? e.message : 'Unexpected error' };
  }
});

/** Upper bound on search results returned to the bind picker. */
const LIST_RESULT_CAP = 50;

resolver.define('canonListProcedures', async (req) => {
  try {
    const r = req as IssueReq;
    const issueKey = r.context?.extension?.issue?.key;
    const accountId = r.context?.accountId;
    if (!issueKey || !accountId) return { ok: false, error: 'NO_ACCESS', message: 'Missing issue or user context.' };

    // Optional case-insensitive title filter; a missing or non-string query matches everything.
    const rawQuery = (r.payload as { query?: unknown } | undefined)?.query;
    const query = typeof rawQuery === 'string' ? rawQuery.trim().toLowerCase() : '';

    const candidates = (await createKvsRepos().procedures.listControlled()).filter(
      (p) => p.currentApproved !== null && p.title.toLowerCase().includes(query),
    );

    // Drop anything the current user cannot view, so titles of hidden pages never leak.
    const procedures: { pageId: string; title: string; currentApproved: number }[] = [];
    for (const p of candidates) {
      if (procedures.length >= LIST_RESULT_CAP) break;
      if (p.currentApproved === null) continue;
      if (await canUserView(p.pageId)) {
        procedures.push({ pageId: p.pageId, title: p.title, currentApproved: p.currentApproved });
      }
    }
    return { ok: true, procedures };
  } catch (e) {
    return { ok: false, error: 'INTERNAL', message: e instanceof Error ? e.message : 'Unexpected error' };
  }
});

/**
 * Returns the delta for one binding on the current issue.
 * Order of checks: issue/user context, then payload, then binding lookup (wrong issue = NOT_FOUND),
 * then page visibility (NO_ACCESS). The page must be viewable by the user before any delta is read.
 */
resolver.define('canonBindingDelta', async (req) => {
  try {
    const r = req as IssueReq;
    const issueKey = r.context?.extension?.issue?.key;
    const accountId = r.context?.accountId;
    if (!issueKey || !accountId) return { ok: false, error: 'NO_ACCESS', message: 'Missing issue or user context.' };

    const bindingId = (r.payload as { bindingId?: unknown } | undefined)?.bindingId;
    if (typeof bindingId !== 'string' || bindingId === '') {
      return { ok: false, error: 'INVALID_INPUT', message: 'payload.bindingId must be a non-empty string.' };
    }

    // Load the binding first so we know which page to check. A binding on another issue looks missing.
    const repos = createKvsRepos();
    const binding = await repos.bindings.get(bindingId);
    if (!binding || binding.issueKey !== issueKey) {
      return { ok: false, error: 'NOT_FOUND', message: 'No such binding on this issue.' };
    }
    if (!(await canUserView(binding.pageId))) return { ok: false, error: 'NO_ACCESS', message: 'You do not have access to this page.' };

    const delta = await getBindingDelta(repos, fetchBody, { issueKey, bindingId });
    return { ok: true, delta };
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') {
      return { ok: false, error: 'NOT_FOUND', message: 'No such binding on this issue.' };
    }
    return { ok: false, error: 'INTERNAL', message: e instanceof Error ? e.message : 'Unexpected error' };
  }
});

resolver.define('canonBind', async (req) => {
  try {
    const r = req as IssueReq;
    const issueKey = r.context?.extension?.issue?.key;
    const accountId = r.context?.accountId;
    if (!issueKey || !accountId) return { ok: false, error: 'NO_ACCESS', message: 'Missing issue or user context.' };

    const pageId = (r.payload as { pageId?: unknown } | undefined)?.pageId;
    if (typeof pageId !== 'string' || pageId === '') {
      return { ok: false, error: 'INVALID_INPUT', message: 'payload.pageId must be a non-empty string.' };
    }
    if (!(await canUserView(pageId))) return { ok: false, error: 'NO_ACCESS', message: 'You do not have access to this page.' };

    const binding = await bindIssue(createKvsRepos(), {
      issueKey,
      pageId,
      actor: accountId,
      at: new Date().toISOString(),
    });
    return { ok: true, binding };
  } catch (e) {
    if (e instanceof BindError) return { ok: false, error: e.code, message: e.message };
    return { ok: false, error: 'INTERNAL', message: e instanceof Error ? e.message : 'Unexpected error' };
  }
});

resolver.define('canonApprove', (req) =>
  guarded(req as Req, async (pageId, actor) => {
    const version = (req as Req).payload && ((req as Req).payload as { version?: unknown }).version;
    if (typeof version !== 'number' || !Number.isInteger(version)) throw new Error('payload.version must be an integer');
    const meta = await getPageMeta(pageId);
    const r = await approveVersion(createKvsRepos(), fetchBody, meta, { version, actor, at: new Date().toISOString() });
    return { procedure: r.procedure, supersede: r.supersede };
  }),
);

export const handler = resolver.getDefinitions();
