// Dependency-free panel helpers (safe to import from the frontend bundle).
import type { BindingState } from './types';

type ViewBinding = { restricted: boolean; state: BindingState };

/** True when the user can see at least one binding that needs re-attestation (shows "Ask Canon"). */
export function needsReattestation(bindings: readonly ViewBinding[]): boolean {
  return bindings.some((b) => !b.restricted && (b.state === 'SUPERSEDED' || b.state === 'REATTESTING'));
}

export const ROVO_UNAVAILABLE_MESSAGE =
  "Rovo isn't available here. Use the Delta and Attest tabs; the gate works without Rovo.";
