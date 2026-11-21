import type { PageMeta } from './approve';
import { handlePageEvent } from './pageEvent';
import type { Repos } from './repos';
import type { BodyFetcher } from './supersede';

export type ReconcileDeps = {
  getPageMeta(pageId: string): Promise<PageMeta>;
  fetchBody: BodyFetcher;
  now(): string;
};

export type ReconcileResult = {
  checked: number;
  results: Array<{ pageId: string; action: string; detail?: unknown }>;
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isGone(message: string): boolean {
  return message.includes(' 404') || message.includes(' 410');
}

/**
 * Polls Confluence for every page with open bindings, catching missed events:
 * newer versions are replayed as synthetic update events, vanished pages as trashed events.
 * Never throws for per-page failures.
 */
export async function reconcile(
  repos: Repos,
  deps: ReconcileDeps,
  opts: { maxPages?: number } = {},
): Promise<ReconcileResult> {
  const maxPages = opts.maxPages ?? 25;
  const pageIds = (await repos.procedures.listWithOpenBindings()).slice(0, Math.max(0, maxPages));
  const results: ReconcileResult['results'] = [];

  for (const pageId of pageIds) {
    try {
      let meta: PageMeta;
      try {
        meta = await deps.getPageMeta(pageId);
      } catch (e) {
        const message = errorMessage(e);
        if (!isGone(message)) {
          results.push({ pageId, action: 'ERROR', detail: message });
          continue;
        }
        const r = await handlePageEvent(repos, deps, {
          eventType: 'avi:confluence:trashed:page',
          content: { id: pageId },
        });
        results.push({ pageId, action: r.action, detail: r });
        await touch(repos, deps, pageId);
        continue;
      }

      const procedure = await repos.procedures.get(pageId);
      if (meta.currentVersion > (procedure?.lastSeenVersion ?? 0)) {
        const r = await handlePageEvent(repos, deps, {
          eventType: 'avi:confluence:updated:page',
          content: { id: pageId, version: { number: meta.currentVersion } },
        });
        results.push({ pageId, action: r.action, detail: r });
      } else {
        results.push({ pageId, action: 'UNCHANGED' });
      }
      await touch(repos, deps, pageId);
    } catch (e) {
      results.push({ pageId, action: 'ERROR', detail: errorMessage(e) });
    }
  }

  return { checked: pageIds.length, results };
}

async function touch(repos: Repos, deps: ReconcileDeps, pageId: string): Promise<void> {
  const procedure = await repos.procedures.get(pageId);
  if (procedure) await repos.procedures.put({ ...procedure, lastCheckedAt: deps.now() });
}
