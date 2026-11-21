import type { Repos } from './repos';
import type { BindingState } from './types';

export const RESTRICTED_LABEL = 'Procedure restricted';

export interface IssueBindingView {
  id: string;
  pageId: string;
  state: BindingState;
  boundVersion: number;
  restricted: boolean;
  title?: string;
  currentApproved?: number | null;
  latestDeltaKey?: { from: number; to: number } | null;
  override?: { by: string; at: string; reason: string };
}

export interface IssueView {
  issueKey: string;
  bindings: IssueBindingView[];
}

export async function buildIssueView(
  repos: Repos,
  issueKey: string,
  deps: { canView(pageId: string): Promise<boolean> },
): Promise<IssueView> {
  const bindings = await repos.bindings.listByIssue(issueKey);
  const views: IssueBindingView[] = [];

  for (const b of bindings) {
    let visible: boolean;
    try {
      visible = await deps.canView(b.pageId);
    } catch {
      visible = false;
    }

    // Fail closed: a restricted view carries nothing derived from the page.
    if (!visible) {
      views.push({ id: b.id, pageId: b.pageId, state: b.state, boundVersion: b.boundVersion, restricted: true });
      continue;
    }

    const procedure = await repos.procedures.get(b.pageId);
    const currentApproved = procedure?.currentApproved ?? null;
    const needsDelta =
      (b.state === 'SUPERSEDED' || b.state === 'REATTESTING') &&
      currentApproved !== null &&
      currentApproved > b.boundVersion;

    const view: IssueBindingView = {
      id: b.id,
      pageId: b.pageId,
      state: b.state,
      boundVersion: b.boundVersion,
      restricted: false,
      currentApproved,
      latestDeltaKey: needsDelta ? { from: b.boundVersion, to: currentApproved } : null,
    };
    if (procedure) view.title = procedure.title;
    if (b.override) view.override = { by: b.override.by, at: b.override.at, reason: b.override.reason };
    views.push(view);
  }

  return { issueKey, bindings: views };
}
