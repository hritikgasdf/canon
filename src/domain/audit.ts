import { createHash } from 'node:crypto';
import type { AuditRepo } from './repos';
import type { AuditEvent } from './types';

export const GENESIS = '0'.repeat(64);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => (v === undefined ? null : canonicalize(v)));
  }
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      const v = src[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON: object keys sorted recursively, arrays keep order, undefined object fields omitted. */
export function canonicalJson(value: unknown): string {
  const s = JSON.stringify(canonicalize(value));
  return s === undefined ? 'null' : s;
}

export function computeHash(e: Omit<AuditEvent, 'hash'>): string {
  const body = {
    issueKey: e.issueKey,
    seq: e.seq,
    type: e.type,
    actor: e.actor,
    at: e.at,
    payload: e.payload,
    prevHash: e.prevHash,
  };
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export async function appendAudit(
  repo: AuditRepo,
  input: {
    issueKey: string;
    type: string;
    actor: string;
    at: string;
    payload: Record<string, unknown>;
  },
): Promise<AuditEvent> {
  const last = await repo.last(input.issueKey);
  const base: Omit<AuditEvent, 'hash'> = {
    issueKey: input.issueKey,
    seq: last ? last.seq + 1 : 1,
    type: input.type,
    actor: input.actor,
    at: input.at,
    payload: input.payload,
    prevHash: last ? last.hash : GENESIS,
  };
  const event: AuditEvent = { ...base, hash: computeHash(base) };
  await repo.append(event);
  return event;
}

export type ChainResult =
  | { ok: true; count: number; head: string }
  | {
      ok: false;
      brokenAt: number;
      reason: 'HASH_MISMATCH' | 'PREV_MISMATCH' | 'SEQ_GAP' | 'ISSUE_MISMATCH';
    };

/** Verify events in the given order. `brokenAt` is the seq of the first offending event. */
export function verifyChain(events: AuditEvent[]): ChainResult {
  let prevHash = GENESIS;
  let expectedSeq = 1;
  const issueKey = events.length > 0 ? events[0].issueKey : '';
  for (const e of events) {
    if (e.issueKey !== issueKey) return { ok: false, brokenAt: e.seq, reason: 'ISSUE_MISMATCH' };
    if (e.seq !== expectedSeq) return { ok: false, brokenAt: e.seq, reason: 'SEQ_GAP' };
    if (e.prevHash !== prevHash) return { ok: false, brokenAt: e.seq, reason: 'PREV_MISMATCH' };
    const { hash, ...rest } = e;
    if (computeHash(rest) !== hash) return { ok: false, brokenAt: e.seq, reason: 'HASH_MISMATCH' };
    prevHash = hash;
    expectedSeq += 1;
  }
  return { ok: true, count: events.length, head: prevHash };
}
