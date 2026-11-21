import { appendAudit } from './audit';
import { diffProcedures } from './diff';
import { snapshotFromXhtml } from './parse';
import type { Repos } from './repos';
import type { BindingState, Delta, Snapshot } from './types';

/** Returns the storage XHTML of a specific page version. Errors must propagate. */
export type BodyFetcher = (pageId: string, version: number) => Promise<string>;

export type SupersedeResult = {
  pageId: string;
  toVersion: number;
  deltaCreated: boolean;
  /** binding ids */
  superseded: string[];
  skipped: string[];
};

const STATES: BindingState[] = ['CURRENT', 'CLEARED', 'REATTESTING', 'SUPERSEDED'];

export async function ensureSnapshot(
  repos: Repos,
  fetchBody: BodyFetcher,
  pageId: string,
  version: number,
): Promise<Snapshot> {
  const stored = await repos.snapshots.get(pageId, version);
  if (stored) return stored;
  const snap = snapshotFromXhtml(pageId, version, await fetchBody(pageId, version));
  await repos.snapshots.put(snap);
  return snap;
}

export async function ensureDelta(
  repos: Repos,
  fetchBody: BodyFetcher,
  pageId: string,
  from: number,
  to: number,
): Promise<{ delta: Delta; created: boolean }> {
  const stored = await repos.deltas.get(pageId, from, to);
  if (stored) return { delta: stored, created: false };
  const a = await ensureSnapshot(repos, fetchBody, pageId, from);
  const b = await ensureSnapshot(repos, fetchBody, pageId, to);
  const delta = diffProcedures({
    pageId,
    fromVersion: from,
    toVersion: to,
    from: a.nodes,
    to: b.nodes,
    fromHash: a.bodyHash,
    toHash: b.bodyHash,
  });
  await repos.deltas.put(delta);
  return { delta, created: true };
}

export async function supersede(
  repos: Repos,
  fetchBody: BodyFetcher,
  input: {
    pageId: string;
    toVersion: number;
    actor: string;
    at: string;
    isIssueOpen?: (issueKey: string) => Promise<boolean>;
  },
): Promise<SupersedeResult> {
  const { pageId, toVersion, actor, at, isIssueOpen } = input;
  const result: SupersedeResult = { pageId, toVersion, deltaCreated: false, superseded: [], skipped: [] };
  const bindings = await repos.bindings.listByPage(pageId, STATES);

  for (const b of bindings) {
    const satisfiedAt = b.state === 'CLEARED' ? (b.supersededBy ?? b.boundVersion) : b.boundVersion;
    if (toVersion <= satisfiedAt) {
      result.skipped.push(b.id);
      continue;
    }
    if ((b.state === 'SUPERSEDED' || b.state === 'REATTESTING') && b.supersededBy === toVersion) {
      result.skipped.push(b.id);
      continue;
    }
    if (isIssueOpen && !(await isIssueOpen(b.issueKey))) {
      result.skipped.push(b.id);
      continue;
    }

    const { delta, created } = await ensureDelta(repos, fetchBody, pageId, satisfiedAt, toVersion);
    if (created) result.deltaCreated = true;

    await repos.bindings.put({ ...b, state: 'SUPERSEDED', supersededBy: toVersion });
    await appendAudit(repos.audit, {
      issueKey: b.issueKey,
      type: 'SUPERSEDED',
      actor,
      at,
      payload: {
        bindingId: b.id,
        pageId,
        fromVersion: satisfiedAt,
        toVersion,
        deltaItems: delta.items.filter((i) => !i.trivial).length,
      },
    });
    result.superseded.push(b.id);
  }
  return result;
}
