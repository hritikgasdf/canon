// Rovo action handlers, called as handler(payload, context). The issue key comes only from
// payload.context.jira.issueKey (trusted); action inputs are never used for authorisation.
import {
  rovoApprovedProcedure,
  rovoAssignChecker,
  rovoCreateChecklist,
  rovoExplainDelta,
  rovoGateStatus,
  type RovoDeps,
  type RovoWriteDeps,
} from '../domain/rovo';
import { canUserView, fetchBody, getPageMeta } from './confluence';
import { createAppRepos } from './kvsRepos';
import { canUserBrowseIssue } from './permissions';

type Failure = { ok: false; error: string; message: string };

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

function extractIssueKey(payload: unknown): string | null {
  const raw = (payload as { context?: { jira?: { issueKey?: unknown } } } | null | undefined)?.context?.jira?.issueKey;
  const key = typeof raw === 'number' ? String(raw) : raw;
  return typeof key === 'string' && ISSUE_KEY.test(key) ? key : null;
}

const noContext = (): Failure => ({ ok: false, error: 'NO_CONTEXT', message: 'Open this from a Jira work item.' });

function deps(): RovoDeps {
  return {
    repos: createAppRepos(),
    getPageMeta,
    fetchBody,
    canView: canUserView,
    now: () => new Date().toISOString(),
  };
}

async function run<T extends object>(payload: unknown, fn: (issueKey: string) => Promise<T>): Promise<T | Failure> {
  const issueKey = extractIssueKey(payload);
  if (issueKey === null) return noContext();
  try {
    return await fn(issueKey);
  } catch (e) {
    // Never pass internal error text (KVS/Confluence) to the model or the user; log it instead.
    console.error(JSON.stringify({ tag: 'canon-rovo-error', error: e instanceof Error ? e.message : String(e) }));
    return {
      ok: false,
      error: 'UNVERIFIED',
      message: 'Canon could not read the procedure data right now, so nothing can be confirmed. Try again, or open the Canon panel.',
    };
  }
}

export function getGateStatus(payload: unknown, context?: unknown): Promise<object> {
  void context; // the acting user is applied by canUserView (asUser)
  return run(payload, (key) => rovoGateStatus(key, deps()));
}

export function explainDelta(payload: unknown, context?: unknown): Promise<object> {
  void context;
  return run(payload, (key) => rovoExplainDelta(key, deps()));
}

export function getApprovedProcedure(payload: unknown, context?: unknown): Promise<object> {
  void context;
  const raw = (payload as { version?: unknown } | null | undefined)?.version;
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (n !== undefined && n !== null && !(typeof n === 'number' && Number.isInteger(n) && n > 0)) {
    return Promise.resolve<Failure>({ ok: false, error: 'INVALID_INPUT', message: 'version must be a positive integer.' });
  }
  const version = typeof n === 'number' ? n : undefined;
  return run(payload, (key) => rovoApprovedProcedure(key, version, deps()));
}

function writeDeps(): RovoWriteDeps {
  return { ...deps(), canUserBrowseIssue };
}

// The actor comes only from the trusted invocation context, never from action inputs.
function extractActor(context: unknown): string | null {
  const id = (context as { accountId?: unknown } | null | undefined)?.accountId;
  return typeof id === 'string' && id !== '' ? id : null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export function createReattestChecklist(payload: unknown, context?: unknown): Promise<object> {
  const actor = extractActor(context);
  if (actor === null) return Promise.resolve(noContext());
  const p = (payload ?? {}) as { itemIdsJson?: unknown; tasksJson?: unknown; bindingId?: unknown };
  return run(payload, (key) =>
    rovoCreateChecklist(key, actor, { bindingId: str(p.bindingId), itemIdsJson: p.itemIdsJson, tasksJson: p.tasksJson }, writeDeps()),
  );
}

export function assignChecker(payload: unknown, context?: unknown): Promise<object> {
  const actor = extractActor(context);
  if (actor === null) return Promise.resolve(noContext());
  const p = (payload ?? {}) as { checkerAccountId?: unknown; bindingId?: unknown };
  return run(payload, (key) =>
    rovoAssignChecker(key, actor, { bindingId: str(p.bindingId), checkerAccountId: p.checkerAccountId }, writeDeps()),
  );
}
