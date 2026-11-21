// Project register: every binding in a Jira project, with permission-aware redaction. Pure; deps injected.
import { verifyChain } from './audit';
import type { Repos } from './repos';
import type { Binding, BindingState } from './types';

export type RegisterStatus = BindingState | 'CLOSED';

export interface RegisterRow {
  bindingId: string;
  issueKey: string;
  pageId: string;
  status: RegisterStatus;
  /** Omitted for restricted rows. */
  boundVersion?: number;
  supersededBy?: number;
  currentApproved?: number | null;
  title?: string;
  restricted: boolean;
  overridden: boolean;
  boundAt: string;
  closedAt?: string;
}

export interface Register {
  projectKey: string;
  rows: RegisterRow[];
  counts: Record<RegisterStatus, number>;
}

export interface RegisterDeps {
  repos: Repos;
  canView(pageId: string): Promise<boolean>;
  /** Optional issue-level visibility filter (issue security). Returns the keys the viewer can browse. */
  visibleIssues?(issueKeys: string[]): Promise<Set<string>>;
}

const ORDER: RegisterStatus[] = ['SUPERSEDED', 'REATTESTING', 'ORPHANED', 'CURRENT', 'CLEARED', 'CLOSED'];
export const VERIFY_ISSUE_CAP = 200;
const VERIFY_BATCH = 10;

const statusOf = (b: Binding): RegisterStatus => (b.closedAt ? 'CLOSED' : b.state);
const naturalCmp = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/**
 * A CURRENT open binding whose procedure now has a newer approved version is effectively
 * superseded (the gate would block Done), even if no supersede was recorded yet — e.g. work
 * reopened after the approval.
 */
function effectiveStatus(b: Binding, p: { currentApproved: number | null } | null): RegisterStatus {
  const s = statusOf(b);
  if (s === 'CURRENT' && p?.currentApproved != null && p.currentApproved > b.boundVersion) return 'SUPERSEDED';
  return s;
}

export async function buildRegister(deps: RegisterDeps, { projectKey }: { projectKey: string }): Promise<Register> {
  const { repos } = deps;
  const [controlled, openPages] = await Promise.all([
    repos.procedures.listControlled(),
    repos.procedures.listWithOpenBindings(),
  ]);
  const pageIds = [...new Set([...controlled.map((p) => p.pageId), ...openPages])];
  const lists = await Promise.all(pageIds.map((id) => repos.bindings.listByPage(id)));

  const prefix = `${projectKey}-`;
  const byId = new Map<string, Binding>();
  for (const b of lists.flat()) if (b.issueKey.startsWith(prefix)) byId.set(b.id, b);
  let bindings = [...byId.values()];
  if (deps.visibleIssues) {
    // Issue-level security: drop rows for work items the viewer can't browse. Any error hides all.
    const keys = [...new Set(bindings.map((b) => b.issueKey))];
    const ok = await deps.visibleIssues(keys).catch(() => new Set<string>());
    bindings = bindings.filter((b) => ok.has(b.issueKey));
  }

  const pages = [...new Set(bindings.map((b) => b.pageId))];
  const visible = new Map(
    await Promise.all(pages.map(async (id) => [id, await deps.canView(id).catch(() => false)] as const)),
  );
  const procs = new Map(await Promise.all(pages.map(async (id) => [id, await repos.procedures.get(id)] as const)));

  let restrictedSeq = 0;
  const rows: RegisterRow[] = bindings.map((b) => {
    const row: RegisterRow = {
      bindingId: b.id,
      issueKey: b.issueKey,
      pageId: b.pageId,
      status: statusOf(b),
      restricted: visible.get(b.pageId) !== true,
      overridden: b.override !== undefined,
      boundAt: b.boundAt,
    };
    if (b.closedAt) row.closedAt = b.closedAt;
    // Fail closed: a restricted row carries nothing derived from the page.
    if (row.restricted) {
      // No page id, versions or live-derived status for a page the viewer can't see.
      row.bindingId = `restricted:${b.issueKey}:${restrictedSeq++}`;
      row.pageId = '';
    } else {
      const p = procs.get(b.pageId);
      row.status = effectiveStatus(b, p ?? null);
      row.boundVersion = b.boundVersion;
      if (b.supersededBy !== undefined) row.supersededBy = b.supersededBy;
      row.currentApproved = p?.currentApproved ?? null;
      if (p) row.title = p.title;
    }
    return row;
  });

  rows.sort(
    (a, b) =>
      ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
      naturalCmp(a.issueKey, b.issueKey) ||
      naturalCmp(a.bindingId, b.bindingId),
  );

  const counts = Object.fromEntries(ORDER.map((s) => [s, 0])) as Record<RegisterStatus, number>;
  for (const r of rows) counts[r.status] += 1;
  return { projectKey, rows, counts };
}

export interface ChainCheck {
  issueKey: string;
  ok: boolean;
  events: number;
  firstBadSeq?: number;
}

export async function verifyRegisterChains(
  repos: Repos,
  issueKeys: string[],
): Promise<{ results: ChainCheck[]; allOk: boolean; checked: number; truncated: boolean }> {
  const distinct = [...new Set(issueKeys)];
  const keys = distinct.slice(0, VERIFY_ISSUE_CAP);
  const results: ChainCheck[] = [];
  for (let i = 0; i < keys.length; i += VERIFY_BATCH) {
    const batch = await Promise.all(
      keys.slice(i, i + VERIFY_BATCH).map(async (issueKey): Promise<ChainCheck> => {
        const events = await repos.audit.list(issueKey);
        const r = verifyChain(events);
        return r.ok
          ? { issueKey, ok: true, events: events.length }
          : {
              issueKey,
              ok: false,
              events: events.length,
              firstBadSeq: r.brokenAt,
            };
      }),
    );
    results.push(...batch);
  }
  return {
    results,
    // A truncated run is never reported as a full pass.
    allOk: distinct.length <= VERIFY_ISSUE_CAP && results.every((r) => r.ok),
    checked: results.length,
    truncated: distinct.length > VERIFY_ISSUE_CAP,
  };
}
