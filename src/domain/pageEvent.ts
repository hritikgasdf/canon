import { appendAudit } from './audit';
import { approveVersion, type PageMeta } from './approve';
import type { Repos } from './repos';
import type { BindingState } from './types';
import { ensureDelta, type BodyFetcher } from './supersede';

export type PageEventDeps = {
  getPageMeta(pageId: string): Promise<PageMeta>;
  fetchBody: BodyFetcher;
  now(): string;
};

export type PageEventResult =
  | { action: 'IGNORED'; reason: string }
  | { action: 'DRAFT_SEEN'; pageId: string; version: number; reason?: string }
  | { action: 'AUTO_APPROVED'; pageId: string; version: number; superseded: string[] }
  | { action: 'ORPHANED'; pageId: string; bindings: string[] };

const UPDATE_EVENTS = new Set(['avi:confluence:updated:page', 'avi:confluence:created:page']);
const ORPHAN_EVENTS = new Set(['avi:confluence:trashed:page', 'avi:confluence:archived:page', 'avi:confluence:deleted:page']);
const ORPHAN_SOURCE_STATES: BindingState[] = ['CURRENT', 'SUPERSEDED', 'REATTESTING'];

type ParsedEvent = { eventType: string; pageId: string; version: number | null };

function parseEvent(event: unknown): ParsedEvent | { error: string } {
  if (typeof event !== 'object' || event === null) return { error: 'event is not an object' };
  const e = event as Record<string, unknown>;
  if (typeof e.eventType !== 'string') return { error: 'eventType missing' };
  if (typeof e.content !== 'object' || e.content === null) return { error: 'content missing' };
  const content = e.content as Record<string, unknown>;
  if (typeof content.id !== 'string' || content.id.length === 0) return { error: 'content.id missing' };
  let version: number | null = null;
  if (content.version !== undefined) {
    if (typeof content.version !== 'object' || content.version === null) return { error: 'content.version malformed' };
    const n = (content.version as Record<string, unknown>).number;
    if (typeof n !== 'number' || !Number.isInteger(n)) return { error: 'content.version.number not an integer' };
    version = n;
  }
  return { eventType: e.eventType, pageId: content.id, version };
}

export async function handlePageEvent(repos: Repos, deps: PageEventDeps, event: unknown): Promise<PageEventResult> {
  const parsed = parseEvent(event);
  if ('error' in parsed) return { action: 'IGNORED', reason: `malformed event: ${parsed.error}` };
  const { eventType, pageId, version } = parsed;

  if (UPDATE_EVENTS.has(eventType)) {
    if (version === null) return { action: 'IGNORED', reason: 'malformed event: content.version.number missing' };
    const procedure = await repos.procedures.get(pageId);
    if (!procedure || !procedure.controlled) return { action: 'IGNORED', reason: 'not controlled' };

    const now = deps.now();
    await repos.procedures.put({
      ...procedure,
      lastSeenVersion: Math.max(procedure.lastSeenVersion ?? 0, version),
      lastCheckedAt: now,
    });

    if (procedure.policy === 'every-major') {
      const meta = await deps.getPageMeta(pageId);
      if (!meta.minorEdit && meta.currentVersion === version && version > (procedure.currentApproved ?? 0)) {
        // Confluence does not persist minorEdit, so also skip trivial-only changes.
        if (procedure.currentApproved !== null && procedure.currentApproved !== undefined) {
          const { delta } = await ensureDelta(repos, deps.fetchBody, pageId, procedure.currentApproved, version);
          if (!delta.items.some((i) => i.trivial === false)) {
            return { action: 'DRAFT_SEEN', pageId, version, reason: 'trivial-only' };
          }
        }
        const { supersede } = await approveVersion(repos, deps.fetchBody, meta, {
          version,
          actor: 'canon:auto',
          at: now,
        });
        return { action: 'AUTO_APPROVED', pageId, version, superseded: supersede?.superseded ?? [] };
      }
    }
    return { action: 'DRAFT_SEEN', pageId, version };
  }

  if (ORPHAN_EVENTS.has(eventType)) {
    const at = deps.now();
    const bindings = await repos.bindings.listByPage(pageId, ORPHAN_SOURCE_STATES);
    for (const b of bindings) {
      await repos.bindings.put({ ...b, state: 'ORPHANED' });
      await appendAudit(repos.audit, {
        issueKey: b.issueKey,
        type: 'BINDING_ORPHANED',
        actor: 'canon:system',
        at,
        payload: { pageId, bindingId: b.id, eventType },
      });
    }
    const procedure = await repos.procedures.get(pageId);
    if (procedure) await repos.procedures.put({ ...procedure, orphaned: true });
    return { action: 'ORPHANED', pageId, bindings: bindings.map((b) => b.id) };
  }

  return { action: 'IGNORED', reason: `unhandled eventType: ${eventType}` };
}
