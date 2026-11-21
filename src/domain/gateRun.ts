import type { PageMeta } from './approve';
import { effectiveTarget, evaluateGate, type GateDecision } from './gateEval';
import { handlePageEvent } from './pageEvent';
import type { Repos } from './repos';
import type { BodyFetcher } from './supersede';
import type { Attestation, Binding, Procedure } from './types';

export type GateRunDeps = {
  repos: Repos;
  getPageMeta(pageId: string): Promise<PageMeta>;
  fetchBody: BodyFetcher;
  now(): string;
};

function isGone(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes(' 404') || m.includes(' 410');
}

/** Evaluates the gate for an issue. Throws on unexpected errors; the caller must fail closed. */
export async function runCanonGate(
  issueKey: string,
  deps: GateRunDeps,
): Promise<GateDecision & { bindingCount: number }> {
  const { repos } = deps;
  const initial = await repos.bindings.listByIssue(issueKey);
  if (initial.length === 0) return { allow: true, warnOnly: false, reasons: [], bindingCount: 0 };

  const settingsP = repos.settings.get(); // independent; read concurrently
  settingsP.catch(() => undefined); // awaited below; avoid an unhandled rejection meanwhile
  const pageIds = [...new Set(initial.map((b) => b.pageId))];
  const liveVersions: Record<string, number | null | 'NOT_FOUND'> = {};
  const procedures: Record<string, Procedure | null> = {};
  const bindingsByPage: Record<string, Binding[]> = {};

  await Promise.all(pageIds.map(async (pageId) => {
    const liveP = deps.getPageMeta(pageId).then(
      (m): number | 'NOT_FOUND' => m.currentVersion,
      (e: unknown): 'NOT_FOUND' => {
        if (!isGone(e)) throw e;
        return 'NOT_FOUND';
      },
    );
    const [live, stored] = await Promise.all([liveP, repos.procedures.get(pageId)]);
    liveVersions[pageId] = live;

    let proc = stored;
    let refreshed = false;
    if (typeof live === 'number' && proc && live > (proc.lastSeenVersion ?? 0)) {
      await handlePageEvent(repos, deps, {
        eventType: 'avi:confluence:updated:page',
        content: { id: pageId, version: { number: live } },
      });
      proc = await repos.procedures.get(pageId);
      refreshed = true;
    }
    procedures[pageId] = proc;
    // Bindings only change here through the inline supersede, so re-read them only after it ran.
    const source = refreshed ? await repos.bindings.listByIssue(issueKey) : initial;
    bindingsByPage[pageId] = source.filter((b) => b.pageId === pageId);
  }));

  const bindings = pageIds.flatMap((id) => bindingsByPage[id] ?? []);
  const attestations: Record<string, Attestation | null> = {};
  await Promise.all(
    bindings.map(async (b) => {
      const proc = procedures[b.pageId];
      const live = liveVersions[b.pageId];
      attestations[b.id] =
        proc && typeof live === 'number' ? await repos.attestations.get(b.id, effectiveTarget(b, proc, live)) : null;
    }),
  );

  const mode = (await settingsP).validatorMode;
  const decision = evaluateGate({ issueKey, mode, bindings, procedures, liveVersions, attestations });
  return { ...decision, bindingCount: bindings.length };
}
