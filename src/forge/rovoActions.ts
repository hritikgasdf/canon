// Rovo action handlers, called as handler(payload, context). The issue key comes only from
// payload.context.jira.issueKey (trusted); action inputs are never used for authorisation.
import { rovoApprovedProcedure, rovoExplainDelta, rovoGateStatus, type RovoDeps } from '../domain/rovo';
import { canUserView, fetchBody, getPageMeta } from './confluence';
import { createAppRepos } from './kvsRepos';

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
    return { ok: false, error: 'INTERNAL', message: e instanceof Error ? e.message : 'Unexpected error' };
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
