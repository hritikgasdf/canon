import type { Binding, BindingState } from './types';

export type IssueSummaryState = 'NONE' | 'ORPHANED' | 'SUPERSEDED' | 'REATTESTING' | 'CURRENT' | 'CLEARED' | 'CLOSED';

export interface IssueSummary {
  state: IssueSummaryState;
  bindingCount: number;
  /** boundVersion of the binding that decided the state; null when NONE. */
  boundVersion: number | null;
  /** supersededBy of the deciding binding; null unless the state is SUPERSEDED. */
  targetVersion: number | null;
  /** Distinct pageIds across all bindings on the issue, in first-seen order. */
  pageIds: string[];
}

/** Worst-first precedence. Index 0 is the worst state. */
const PRECEDENCE: readonly BindingState[] = ['ORPHANED', 'SUPERSEDED', 'REATTESTING', 'CURRENT', 'CLEARED'];

/**
 * Summarises all bindings on one issue into a single state. The worst binding decides;
 * ties keep the first binding in input order. Pure: no Forge imports.
 */
export function summarizeIssue(bindings: Binding[]): IssueSummary {
  const pageIds = [...new Set(bindings.map((b) => b.pageId))];
  if (bindings.length === 0) {
    return { state: 'NONE', bindingCount: 0, boundVersion: null, targetVersion: null, pageIds };
  }

  if (bindings.every((b) => b.closedAt !== undefined)) {
    // The binding with the highest boundVersion is decisive (first wins ties).
    const highest = Math.max(...bindings.map((b) => b.boundVersion));
    return { state: 'CLOSED', bindingCount: bindings.length, boundVersion: highest, targetVersion: null, pageIds };
  }

  // Closed bindings no longer decide the state while another binding is still open.
  const live = bindings.filter((b) => b.closedAt === undefined);
  let decider: Binding = live[0] as Binding;
  let rank = PRECEDENCE.indexOf(decider.state);
  for (const b of live.slice(1)) {
    const r = PRECEDENCE.indexOf(b.state);
    if (r < rank) {
      decider = b;
      rank = r;
    }
  }

  return {
    state: decider.state,
    bindingCount: bindings.length,
    boundVersion: decider.boundVersion,
    targetVersion: decider.state === 'SUPERSEDED' && decider.supersededBy !== undefined ? decider.supersededBy : null,
    pageIds,
  };
}
