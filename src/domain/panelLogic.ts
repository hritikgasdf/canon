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

/** After Ask Canon: check every 5 s for up to 60 s (12 light view reads at most), stopping at the first change. */
export const ROVO_POLL_INTERVAL_MS = 5000;
export const ROVO_POLL_WINDOW_MS = 60000;
/** Window focus / tab visibility refetches are throttled to one per this interval. */
export const FOCUS_REFRESH_MIN_MS = 10000;

export function shouldRefreshOnFocus(lastRefreshAt: number, now: number): boolean {
  return now - lastRefreshAt >= FOCUS_REFRESH_MIN_MS;
}
