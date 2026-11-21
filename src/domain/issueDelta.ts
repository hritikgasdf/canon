// Read model for the "what changed since I was bound" view of one binding.
// Pure domain logic: no @forge/* imports. The Forge layer supplies the repos and the body fetcher.
import type { Repos } from './repos';
import { ensureDelta, type BodyFetcher } from './supersede';
import type { DeltaItem } from './types';

/** Per-kind tally of every delta item, trivial ones included. */
export interface DeltaCounts {
  ADDED: number;
  REMOVED: number;
  CHANGED: number;
  MOVED: number;
}

/** What the Jira issue panel needs to show for one binding. */
export interface BindingDeltaView {
  bindingId: string;
  pageId: string;
  title: string;
  /** The version the issue is currently bound to. */
  fromVersion: number;
  /** The version the binding must be re-attested against; null when nothing is newer. */
  toVersion: number | null;
  /** Every delta item, trivial ones included. Use materialCount for the number that blocks. */
  items: DeltaItem[];
  counts: DeltaCounts;
  /** Number of items with trivial === false. */
  materialCount: number;
}

/**
 * Returns the delta between the version a binding is bound to and the version it must
 * move to. Throws Error('NOT_FOUND') when the binding does not exist or belongs to another issue,
 * so callers cannot probe bindings across issues.
 */
export async function getBindingDelta(
  repos: Repos,
  fetchBody: BodyFetcher,
  p: { issueKey: string; bindingId: string },
): Promise<BindingDeltaView> {
  const binding = await repos.bindings.get(p.bindingId);
  if (!binding || binding.issueKey !== p.issueKey) throw new Error('NOT_FOUND');

  const procedure = await repos.procedures.get(binding.pageId);
  const title = procedure?.title ?? '';
  const fromVersion = binding.boundVersion;

  // A superseded binding already knows its target. Otherwise the target is the latest approved version.
  const target = binding.supersededBy ?? procedure?.currentApproved ?? null;

  // Nothing newer to attest against: return an empty view and do not touch Confluence.
  if (target === null || target <= fromVersion) {
    return {
      bindingId: binding.id,
      pageId: binding.pageId,
      title,
      fromVersion,
      toVersion: null,
      items: [],
      counts: { ADDED: 0, REMOVED: 0, CHANGED: 0, MOVED: 0 },
      materialCount: 0,
    };
  }

  // Reuses a stored delta when one exists; otherwise computes and stores it.
  const { delta } = await ensureDelta(repos, fetchBody, binding.pageId, fromVersion, target);

  const counts: DeltaCounts = { ADDED: 0, REMOVED: 0, CHANGED: 0, MOVED: 0 };
  let materialCount = 0;
  for (const item of delta.items) {
    counts[item.kind] += 1;
    if (!item.trivial) materialCount += 1;
  }

  return {
    bindingId: binding.id,
    pageId: binding.pageId,
    title,
    fromVersion,
    toVersion: target,
    items: delta.items,
    counts,
    materialCount,
  };
}
