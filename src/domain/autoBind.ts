import { bindIssue, BindError } from './bind';
import type { Repos } from './repos';

export type AutoBindResult = {
  action: 'IGNORED' | 'BOUND' | 'SKIPPED';
  reason?: string;
  issueKey?: string;
  pageId?: string;
  version?: number;
};

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function own(map: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * Auto-bind a Jira issue when it transitions into an "In Progress" (indeterminate) status,
 * using the project/type or type-only mapping from settings.autoBind.
 * Never throws on malformed input; bind refusals are reported as SKIPPED.
 */
export async function handleIssueUpdated(
  repos: Repos,
  event: unknown,
  now: () => string,
): Promise<AutoBindResult> {
  const issue = isObj(event) && isObj(event.issue) ? event.issue : null;
  const fields = issue && isObj(issue.fields) ? issue.fields : null;
  const issueKey = str(issue?.key);
  const projectKey = str(fields && isObj(fields.project) ? fields.project.key : undefined);
  const issueType = str(fields && isObj(fields.issuetype) ? fields.issuetype.name : undefined);
  const statusCategory = str(fields && isObj(fields.status) && isObj(fields.status.statusCategory) ? fields.status.statusCategory.key : undefined);
  const changelog = isObj(event) && isObj(event.changelog) ? event.changelog : null;
  const items = changelog && Array.isArray(changelog.items) ? changelog.items : null;
  if (issueKey === null || projectKey === null || issueType === null || statusCategory === null || items === null) {
    return { action: 'IGNORED', reason: 'malformed' };
  }

  const statusChanged = items.some((item) => isObj(item) && typeof item.field === 'string' && item.field.toLowerCase() === 'status');
  if (!statusChanged || statusCategory !== 'indeterminate') {
    return { action: 'IGNORED', reason: 'not-start-transition' };
  }

  const settings = await repos.settings.get();
  const pageId = own(settings.autoBind, `${projectKey}/${issueType}`) ?? own(settings.autoBind, issueType);
  if (pageId === undefined) {
    return { action: 'IGNORED', reason: 'no-mapping', issueKey };
  }

  try {
    const binding = await bindIssue(repos, { issueKey, pageId, actor: 'canon:auto-bind', at: now() });
    return { action: 'BOUND', issueKey, pageId, version: binding.boundVersion };
  } catch (error) {
    if (error instanceof BindError) {
      return { action: 'SKIPPED', reason: error.code, issueKey, pageId };
    }
    throw error;
  }
}
