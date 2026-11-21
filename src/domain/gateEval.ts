import type { Attestation, Binding, Procedure } from './types';

export type GateInput = {
  issueKey: string;
  mode: 'block' | 'warn';
  bindings: Binding[];
  procedures: Record<string, Procedure | null>;
  liveVersions: Record<string, number | null | 'NOT_FOUND'>;
  attestations: Record<string, Attestation | null>;
};

export type GateReason = {
  pageId: string;
  title: string;
  code: 'SUPERSEDED' | 'REATTESTING' | 'ORPHANED' | 'UNVERIFIED' | 'PENDING_APPROVAL_IGNORED';
  boundVersion: number;
  targetVersion?: number;
  openItems?: number;
};

export type GateDecision = { allow: boolean; warnOnly: boolean; reasons: GateReason[]; message?: string };

export const GATE_FAIL_CLOSED =
  'Canon could not verify the procedure version, so this transition is blocked. Try again; nothing was changed.';

const isSealed = (a: Attestation): boolean =>
  !!a.checkerSignedAt && !!a.sealHash && a.items.every((i) => i.status === 'DONE' || i.status === 'NOT_MATERIAL');

function evaluateBinding(
  b: Binding,
  input: GateInput,
): GateReason | null {
  const proc = input.procedures[b.pageId] ?? null;
  const live = input.liveVersions[b.pageId];
  const satisfiedAt = b.state === 'CLEARED' ? (b.supersededBy ?? b.boundVersion) : b.boundVersion;
  const title = proc?.title ?? `page ${b.pageId}`;
  const base = { pageId: b.pageId, title, boundVersion: satisfiedAt };

  if (b.state === 'ORPHANED' || live === 'NOT_FOUND' || proc?.orphaned === true) {
    return { ...base, code: 'ORPHANED' };
  }
  if (proc === null || typeof live !== 'number') return { ...base, code: 'UNVERIFIED' };

  // currentApproved null = nothing approved is known, so it cannot exceed the bound version.
  let effective = proc.currentApproved ?? 0;
  if (proc.policy === 'every-major') effective = Math.max(effective, live);
  // approved-only with live > currentApproved is a draft pending approval: informational, never blocks.

  if (effective <= satisfiedAt) return null;

  const att = input.attestations[b.id] ?? null;
  if (att && att.toVersion === effective) {
    if (isSealed(att)) return null;
    return {
      ...base,
      code: 'REATTESTING',
      targetVersion: effective,
      openItems: att.items.filter((i) => i.status === 'PENDING').length,
    };
  }
  return { ...base, code: 'SUPERSEDED', targetVersion: effective };
}

function sentence(r: GateReason, issueKey: string): string {
  if (r.code === 'ORPHANED') {
    return `Canon: the bound procedure "${r.title}" was deleted, archived or is no longer visible to Canon.`;
  }
  const head = `Canon: "${r.title}" was revised v${r.boundVersion} → v${r.targetVersion} while ${issueKey} was open.`;
  if (r.openItems === undefined) return `${head} Re-attest the changes in the Canon panel.`;
  const n = r.openItems;
  return `${head} ${n} ${n === 1 ? 'change needs' : 'changes need'} re-attestation in the Canon panel.`;
}

const failClosed = (): GateDecision => ({ allow: false, warnOnly: false, reasons: [], message: GATE_FAIL_CLOSED });

export function evaluateGate(input: GateInput): GateDecision {
  try {
    const reasons: GateReason[] = [];
    for (const b of input.bindings) {
      const r = evaluateBinding(b, input);
      if (r) reasons.push(r);
    }
    const blocking = reasons.filter((r) => r.code !== 'PENDING_APPROVAL_IGNORED');
    if (blocking.length === 0) return { allow: true, warnOnly: false, reasons };

    const message = blocking.some((r) => r.code === 'UNVERIFIED')
      ? GATE_FAIL_CLOSED
      : blocking.map((r) => sentence(r, input.issueKey)).join(' ');
    if (input.mode === 'warn') return { allow: true, warnOnly: true, reasons, message };
    return { allow: false, warnOnly: false, reasons, message };
  } catch {
    return failClosed();
  }
}
