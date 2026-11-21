// Pure orchestration for issue visibility (no @forge imports, so it is unit-testable).

export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-[0-9]+$/;

export type VisibilityIo = {
  /** One as-user JQL search for the chunk; returns the keys found, or null if the search failed. */
  search(chunk: string[]): Promise<string[] | null>;
  /** As-user GET of one issue; true only on 200. */
  getOne(key: string): Promise<boolean>;
};

/**
 * The subset of `issueKeys` the user can browse. Invalid keys are dropped before any JQL is built.
 * One search per 100 keys; if a search fails (e.g. a deleted or hidden key makes JQL error), that
 * chunk falls back to per-issue GETs, 10 at a time. Any error hides the issue (fail closed).
 */
export async function visibleIssuesWith(issueKeys: string[], io: VisibilityIo): Promise<Set<string>> {
  const out = new Set<string>();
  const keys = [...new Set(issueKeys.filter((k) => ISSUE_KEY_RE.test(k)))];
  for (let c = 0; c < keys.length; c += 100) {
    const chunk = keys.slice(c, c + 100);
    let found: string[] | null = null;
    try {
      found = await io.search(chunk);
    } catch {
      found = null;
    }
    if (found !== null) {
      for (const k of found) if (chunk.includes(k)) out.add(k);
      continue;
    }
    for (let i = 0; i < chunk.length; i += 10) {
      await Promise.all(
        chunk.slice(i, i + 10).map(async (key) => {
          try {
            if ((await io.getOne(key)) === true) out.add(key);
          } catch {
            // hidden
          }
        }),
      );
    }
  }
  return out;
}
