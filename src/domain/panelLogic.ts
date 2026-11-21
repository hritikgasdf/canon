// Dependency-free panel helpers (safe to import from the frontend bundle).
import type { BindingState } from './types';

type ViewBinding = { restricted: boolean; state: BindingState };

/** True when the user can see at least one binding that needs re-attestation (shows "Ask Canon"). */
export function needsReattestation(bindings: readonly ViewBinding[]): boolean {
  return bindings.some((b) => !b.restricted && (b.state === 'SUPERSEDED' || b.state === 'REATTESTING'));
}

export const ROVO_UNAVAILABLE_MESSAGE =
  "Rovo isn't available here. Use the Delta and Attest tabs; the gate works without Rovo.";

/** The prompt the Ask Canon button sends to the Canon Rovo agent. */
export function askCanonPrompt(issueKey: string, needsRedo: boolean): string {
  return needsRedo
    ? `What changed in my procedure for ${issueKey} and what do I need to redo?`
    : `Is ${issueKey} clear to close?`;
}

/** Ask Canon is offered whenever the work item is bound to at least one controlled procedure. */
export function showAskCanon(bindingCount: number): boolean {
  return bindingCount > 0;
}

/** Compact fingerprint of the bindings a panel shows; a change means the Attest/Evidence tabs must reload. */
export function viewSignature(bindings: readonly { id: string; state: BindingState }[]): string {
  return bindings.map((b) => `${b.id}:${b.state}`).join('|');
}

/**
 * Light polling of the issue view (one small resolver call per tick), stopping at the first change.
 * - After Ask Canon: every 7 s for up to 5 min (a Rovo conversation often takes more than a minute).
 * - Otherwise, while a visible binding is SUPERSEDED with no re-attestation started: every 20 s for up
 *   to 10 min after the panel loaded or last changed, so a checklist created elsewhere still appears.
 * Ticks are skipped while the panel is hidden.
 */
export const ASK_POLL = { intervalMs: 7000, windowMs: 5 * 60 * 1000 } as const;
export const IDLE_POLL = { intervalMs: 20000, windowMs: 10 * 60 * 1000 } as const;

export type PollPlan = { intervalMs: number; until: number } | null;

export function idlePollPlan(bindings: readonly ViewBinding[], now: number): PollPlan {
  const waiting = bindings.some((b) => !b.restricted && b.state === 'SUPERSEDED');
  return waiting ? { intervalMs: IDLE_POLL.intervalMs, until: now + IDLE_POLL.windowMs } : null;
}

export function askPollPlan(now: number): { intervalMs: number; until: number } {
  return { intervalMs: ASK_POLL.intervalMs, until: now + ASK_POLL.windowMs };
}

/** Whether a poll tick should read the view now. */
export function shouldPollTick(plan: PollPlan, now: number, hidden: boolean): 'read' | 'skip' | 'stop' {
  if (plan === null || now > plan.until) return 'stop';
  return hidden ? 'skip' : 'read';
}

/** Tabs whose content depends on attestation data and must refetch when selected (Attest, Evidence). */
export const REFRESH_ON_SELECT_TABS: readonly number[] = [2, 3];

/** Window focus / tab visibility refetches are throttled to one per this interval. */
export const FOCUS_REFRESH_MIN_MS = 10000;

export function shouldRefreshOnFocus(lastRefreshAt: number, now: number): boolean {
  return now - lastRefreshAt >= FOCUS_REFRESH_MIN_MS;
}
