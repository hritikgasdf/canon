import type { Repos } from './repos';
import { summarizeIssue } from './issueSummary';

type IssueSummary = ReturnType<typeof summarizeIssue>;

/**
 * Wraps repos so every bindings.put is followed by a best-effort sync of the issue's
 * summary. A sync failure is logged and never fails the put: the write is the source of
 * truth, the sync is a mirror.
 */
export function withIssueSync(
  repos: Repos,
  sync: (issueKey: string, summary: IssueSummary) => Promise<void>,
  log: (msg: string) => void = () => {},
): Repos {
  return {
    ...repos,
    bindings: {
      ...repos.bindings,
      async put(b) {
        await repos.bindings.put(b);
        try {
          const summary = summarizeIssue(await repos.bindings.listByIssue(b.issueKey));
          await sync(b.issueKey, summary);
        } catch (err) {
          log(`issue sync failed for ${b.issueKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
  };
}
