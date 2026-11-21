import api, { route } from '@forge/api';
import { parseBinding, type Binding } from '../domain/gate';
import { toGateStatus, type GateStatusOk } from '../domain/gateStatus';

function extractIssueKey(payload: unknown): string | null {
  const ctx = payload as { context?: { jira?: { issueKey?: unknown } } } | null | undefined;
  const key = ctx?.context?.jira?.issueKey;
  return typeof key === 'string' && key !== '' ? key : null;
}

async function lookup(issueKey: string): Promise<GateStatusOk> {
  const bindingRes = await api
    .asApp()
    .requestJira(route`/rest/api/3/issue/${issueKey}/properties/canon-binding`);
  if (bindingRes.status === 404) {
    return toGateStatus({ issueKey, binding: null, currentVersion: null });
  }
  if (!bindingRes.ok) {
    return toGateStatus({
      issueKey,
      binding: null,
      currentVersion: null,
      error: `Canon could not read the binding for ${issueKey} (HTTP ${bindingRes.status}). Try again later.`,
    });
  }
  const json = (await bindingRes.json()) as { value?: unknown };
  if (json.value === null || json.value === undefined) {
    return toGateStatus({ issueKey, binding: null, currentVersion: null });
  }

  let binding: Binding;
  try {
    binding = parseBinding(json.value);
  } catch {
    return toGateStatus({
      issueKey,
      binding: null,
      currentVersion: null,
      error: 'Canon binding on this work item is malformed, so its state cannot be verified.',
    });
  }

  const pageRes = await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${binding.pageId}`);
  if (!pageRes.ok) {
    return toGateStatus({
      issueKey,
      binding,
      currentVersion: null,
      error: `Canon could not read the Confluence page (HTTP ${pageRes.status}). Try again later.`,
    });
  }
  const page = (await pageRes.json()) as { version?: { number?: unknown } };
  const v = page.version?.number;
  const currentVersion = typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;

  return toGateStatus({ issueKey, binding, currentVersion });
}

/**
 * Rovo action: is the current Jira work item bound to a Confluence procedure version,
 * and has that procedure been revised since? Read-only. Never throws.
 */
export async function getGateStatus(
  payload: unknown,
  context?: unknown,
): Promise<GateStatusOk | { ok: false; message: string }> {
  void context; // unused: the issue key comes only from the Jira context in payload
  const issueKey = extractIssueKey(payload);
  if (issueKey === null) {
    return { ok: false, message: 'Open this from a Jira work item.' };
  }
  try {
    return await lookup(issueKey);
  } catch {
    return toGateStatus({
      issueKey,
      binding: null,
      currentVersion: null,
      error: 'Canon could not verify the procedure version right now. Try again later.',
    });
  }
}
