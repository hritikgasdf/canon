import { describe, expect, it } from 'vitest';
import { appendAudit, canonicalJson, computeHash, GENESIS, verifyChain } from '../src/domain/audit';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import type { AuditEvent } from '../src/domain/types';

async function build(n = 3, issueKey = 'CAN-1'): Promise<AuditEvent[]> {
  const repos = createMemoryRepos();
  for (let i = 0; i < n; i++) {
    await appendAudit(repos.audit, {
      issueKey,
      type: 'T',
      actor: 'u1',
      at: `2026-11-21T10:00:0${i}.000Z`,
      payload: { i },
    });
  }
  return repos.audit.list(issueKey);
}

function reseal(e: AuditEvent): AuditEvent {
  const rest: Omit<AuditEvent, 'hash'> = {
    issueKey: e.issueKey,
    seq: e.seq,
    type: e.type,
    actor: e.actor,
    at: e.at,
    payload: e.payload,
    prevHash: e.prevHash,
  };
  return { ...rest, hash: computeHash(rest) };
}

describe('canonicalJson', () => {
  it('is key-order independent, recursively', () => {
    const a = { b: 1, a: { d: [1, { y: 1, x: 2 }], c: 3 } };
    const b = { a: { c: 3, d: [1, { x: 2, y: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":3,"d":[1,{"x":2,"y":1}]},"b":1}');
  });
  it('keeps array order and omits undefined fields', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe('audit chain', () => {
  it('GENESIS is 64 zeros', () => {
    expect(GENESIS).toBe('0'.repeat(64));
  });

  it('append 3 then verify ok, head is last hash', async () => {
    const events = await build(3);
    const r = verifyChain(events);
    expect(r).toEqual({ ok: true, count: 3, head: events[2].hash });
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[0].prevHash).toBe(GENESIS);
    expect(events[1].prevHash).toBe(events[0].hash);
  });

  it('empty chain is ok with GENESIS head', () => {
    expect(verifyChain([])).toEqual({ ok: true, count: 0, head: GENESIS });
  });

  it('tampered payload → HASH_MISMATCH at that seq', async () => {
    const events = await build(3);
    events[1] = { ...events[1], payload: { i: 99 } };
    expect(verifyChain(events)).toEqual({ ok: false, brokenAt: 2, reason: 'HASH_MISMATCH' });
  });

  it('deleted middle event → SEQ_GAP', async () => {
    const events = await build(3);
    expect(verifyChain([events[0], events[2]])).toEqual({
      ok: false,
      brokenAt: 3,
      reason: 'SEQ_GAP',
    });
  });

  it('reordered events are detected', async () => {
    const events = await build(3);
    const r = verifyChain([events[0], events[2], events[1]]);
    expect(r.ok).toBe(false);
  });

  it('forged middle event with recomputed hash → PREV_MISMATCH at next', async () => {
    const events = await build(3);
    events[1] = reseal({ ...events[1], payload: { i: 99 } });
    expect(verifyChain(events)).toEqual({ ok: false, brokenAt: 3, reason: 'PREV_MISMATCH' });
  });

  it('forged first event with bad prevHash → PREV_MISMATCH', async () => {
    const events = await build(2);
    events[0] = reseal({ ...events[0], prevHash: 'f'.repeat(64) });
    expect(verifyChain(events)).toEqual({ ok: false, brokenAt: 1, reason: 'PREV_MISMATCH' });
  });

  it('chain not starting at seq 1 → SEQ_GAP', async () => {
    const events = await build(3);
    expect(verifyChain(events.slice(1))).toEqual({ ok: false, brokenAt: 2, reason: 'SEQ_GAP' });
  });

  it('mixed issue keys → ISSUE_MISMATCH', async () => {
    const a = await build(2, 'CAN-1');
    const b = await build(2, 'CAN-2');
    expect(verifyChain([a[0], b[1]])).toEqual({ ok: false, brokenAt: 2, reason: 'ISSUE_MISMATCH' });
  });

  it('two issues chain independently in a memory repo', async () => {
    const repos = createMemoryRepos();
    const mk = (issueKey: string) =>
      appendAudit(repos.audit, { issueKey, type: 'T', actor: 'u', at: '2026-11-21T10:00:00.000Z', payload: {} });
    const a1 = await mk('CAN-1');
    const b1 = await mk('CAN-2');
    const a2 = await mk('CAN-1');
    expect([a1.seq, b1.seq, a2.seq]).toEqual([1, 1, 2]);
    expect(b1.prevHash).toBe(GENESIS);
    expect(a2.prevHash).toBe(a1.hash);
    expect(verifyChain(await repos.audit.list('CAN-1')).ok).toBe(true);
    expect(verifyChain(await repos.audit.list('CAN-2')).ok).toBe(true);
  });
});
