import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AttestError } from '../src/domain/attest';
import { attestItem, getAttestation, signOff, startReattestation } from '../src/domain/attestService';
import { verifyChain } from '../src/domain/audit';
import { evaluateGate } from '../src/domain/gateEval';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import type { Repos } from '../src/domain/repos';
import type { BodyFetcher } from '../src/domain/supersede';
import { DEFAULT_SETTINGS, type Binding, type Procedure } from '../src/domain/types';

const seed = (v: number): string => readFileSync(`seed/sop-pay-014/v${v}.xhtml`, 'utf8');
const bodies: Record<number, string> = { 3: seed(3), 4: seed(4) };
const P = 'p1';
const ISSUE = 'CHG-1';
const B = 'CHG-1.p1';
const AT = '2026-01-01T00:00:00.000Z';
const REASON = 'Cosmetic wording only, no effect';

const procedure: Procedure = {
  pageId: P,
  title: 'SOP PAY-014',
  controlled: true,
  policy: 'approved-only',
  approved: [],
  currentApproved: 4,
  lastSeenVersion: 4,
};
const binding: Binding = {
  id: B,
  issueKey: ISSUE,
  pageId: P,
  boundVersion: 3,
  boundAt: 't',
  boundBy: 'u',
  state: 'SUPERSEDED',
  supersededBy: 4,
};

async function setup(over: Partial<Binding> = {}) {
  const repos: Repos = createMemoryRepos();
  await repos.procedures.put(procedure);
  await repos.bindings.put({ ...binding, ...over });
  const fetchBody = vi.fn<BodyFetcher>(async (_p, v) => bodies[v]);
  return { repos, fetchBody };
}
const ref = { issueKey: ISSUE, bindingId: B };
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AttestError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
};

async function doneAll(repos: Repos, by: string): Promise<void> {
  const att = (await getAttestation(repos, ref))!;
  for (const i of att.items) {
    if (i.status === 'PENDING') {
      await attestItem(repos, { ...ref, itemId: i.itemId, action: 'DONE', note: 'implemented', actor: by, at: AT });
    }
  }
}

describe('attestService', () => {
  it('start flips the binding to REATTESTING and is idempotent', async () => {
    const { repos, fetchBody } = await setup();
    const a = await startReattestation(repos, fetchBody, { ...ref, actor: 'impl', at: AT });
    expect(a.implementer).toBe('impl');
    expect(a.toVersion).toBe(4);
    expect(a.items.length).toBeGreaterThan(0);
    expect((await repos.bindings.get(B))!.state).toBe('REATTESTING');
    const again = await startReattestation(repos, fetchBody, { ...ref, actor: 'other', at: AT });
    expect(again).toEqual(a);
    expect(await repos.audit.list(ISSUE)).toHaveLength(1);
  });

  it('rejects a binding from another issue', async () => {
    const { repos, fetchBody } = await setup();
    expect(await code(startReattestation(repos, fetchBody, { issueKey: 'OTHER-1', bindingId: B, actor: 'i', at: AT }))).toBe('NOT_FOUND');
    expect(await code(getAttestation(repos, { issueKey: 'OTHER-1', bindingId: B }))).toBe('NOT_FOUND');
  });

  it('a CURRENT binding cannot start', async () => {
    const { repos, fetchBody } = await setup({ state: 'CURRENT', supersededBy: undefined });
    expect(await code(startReattestation(repos, fetchBody, { ...ref, actor: 'i', at: AT }))).toBe('BAD_STATE');
    expect(await getAttestation(repos, ref)).toBeNull();
  });

  it('item actions require a started attestation', async () => {
    const { repos } = await setup();
    expect(await code(attestItem(repos, { ...ref, itemId: 'x', action: 'DONE', actor: 'i', at: AT }))).toBe('BAD_STATE');
  });

  it('NOT_MATERIAL without a note is rejected', async () => {
    const { repos, fetchBody } = await setup();
    const a = await startReattestation(repos, fetchBody, { ...ref, actor: 'impl', at: AT });
    const itemId = a.items[0].itemId;
    expect(await code(attestItem(repos, { ...ref, itemId, action: 'NOT_MATERIAL', actor: 'rev', at: AT }))).toBe('NOTE_REQUIRED');
    expect(await code(attestItem(repos, { ...ref, itemId, action: 'NOT_MATERIAL', note: '   ', actor: 'rev', at: AT }))).toBe('NOTE_REQUIRED');
    expect((await getAttestation(repos, ref))!.items[0].status).toBe('PENDING');
  });

  it('the implementer cannot sign', async () => {
    const { repos, fetchBody } = await setup();
    await startReattestation(repos, fetchBody, { ...ref, actor: 'impl', at: AT });
    await doneAll(repos, 'impl');
    expect(await code(signOff(repos, { ...ref, actor: 'impl', at: AT }))).toBe('SELF_SIGN');
    expect((await repos.bindings.get(B))!.state).toBe('REATTESTING');
  });

  it('someone who did a DONE item cannot sign', async () => {
    const { repos, fetchBody } = await setup();
    const a = await startReattestation(repos, fetchBody, { ...ref, actor: 'impl', at: AT });
    await attestItem(repos, { ...ref, itemId: a.items[0].itemId, action: 'NOT_MATERIAL', note: REASON, actor: 'rev', at: AT });
    // 'impl' did the remaining DONE items (if any); a DONE item by 'impl' blocks them as signer too.
    await doneAll(repos, 'impl');
    const att = (await getAttestation(repos, ref))!;
    const doneBy = att.items.find((i) => i.status === 'DONE')?.by;
    expect(doneBy).toBe('impl');
    expect(await code(signOff(repos, { ...ref, actor: doneBy!, at: AT }))).toBe('SELF_SIGN');
    expect((await getAttestation(repos, ref))!.sealHash).toBeUndefined();
  });

  it('a checker who marked an item not material can still sign', async () => {
    const { repos, fetchBody } = await setup();
    const a = await startReattestation(repos, fetchBody, { ...ref, actor: 'impl', at: AT });
    await attestItem(repos, { ...ref, itemId: a.items[0].itemId, action: 'NOT_MATERIAL', note: REASON, actor: 'rev', at: AT });
    await doneAll(repos, 'impl');
    const sealed = await signOff(repos, { ...ref, actor: 'rev', at: AT });
    expect(sealed.sealHash).toBeTruthy();
    expect(sealed.checker).toBe('rev');
    expect(sealed.items[0].status).toBe('NOT_MATERIAL');
    expect((await repos.bindings.get(B))!.state).toBe('CLEARED');
  });

  it('signing with open items is rejected', async () => {
    const { repos, fetchBody } = await setup();
    await startReattestation(repos, fetchBody, { ...ref, actor: 'impl', at: AT });
    expect(await code(signOff(repos, { ...ref, actor: 'qa', at: AT }))).toBe('ITEMS_OPEN');
  });

  it('an independent signer seals, clears the binding and the gate allows', async () => {
    const { repos, fetchBody } = await setup();
    await startReattestation(repos, fetchBody, { ...ref, actor: 'impl', at: AT });
    await doneAll(repos, 'impl');
    const sealed = await signOff(repos, { ...ref, actor: 'qa', at: AT });
    expect(sealed.sealHash).toBeTruthy();
    expect(sealed.checker).toBe('qa');
    const b = (await repos.bindings.get(B))!;
    expect(b).toMatchObject({ state: 'CLEARED', supersededBy: 4 });
    const att = await repos.attestations.get(B, 4);
    const decision = evaluateGate({
      issueKey: ISSUE,
      mode: 'block',
      bindings: [b],
      procedures: { [P]: procedure },
      liveVersions: { [P]: 4 },
      attestations: { [B]: att },
    });
    expect(decision.allow).toBe(true);
  });

  it('the gate still blocks before sign-off', async () => {
    const { repos, fetchBody } = await setup();
    const att = await startReattestation(repos, fetchBody, { ...ref, actor: 'impl', at: AT });
    const decision = evaluateGate({
      issueKey: ISSUE,
      mode: 'block',
      bindings: [(await repos.bindings.get(B))!],
      procedures: { [P]: procedure },
      liveVersions: { [P]: 4 },
      attestations: { [B]: att },
    });
    expect(decision.allow).toBe(false);
  });

  it('requireIndependentApprover=false lets the implementer sign', async () => {
    const { repos, fetchBody } = await setup();
    await repos.settings.put({ ...DEFAULT_SETTINGS, requireIndependentApprover: false });
    await startReattestation(repos, fetchBody, { ...ref, actor: 'impl', at: AT });
    await doneAll(repos, 'impl');
    const sealed = await signOff(repos, { ...ref, actor: 'impl', at: AT });
    expect(sealed.sealHash).toBeTruthy();
    expect((await repos.bindings.get(B))!.state).toBe('CLEARED');
  });

  it('a signed binding cannot be signed again', async () => {
    const { repos, fetchBody } = await setup();
    await startReattestation(repos, fetchBody, { ...ref, actor: 'impl', at: AT });
    await doneAll(repos, 'impl');
    await signOff(repos, { ...ref, actor: 'qa', at: AT });
    expect(await code(signOff(repos, { ...ref, actor: 'qa2', at: AT }))).toBe('BAD_STATE');
  });

  it('appends audit events in order with a valid chain', async () => {
    const { repos, fetchBody } = await setup();
    const a = await startReattestation(repos, fetchBody, { ...ref, actor: 'impl', at: AT });
    await doneAll(repos, 'impl');
    await signOff(repos, { ...ref, actor: 'qa', at: AT });
    const events = await repos.audit.list(ISSUE);
    expect(events.map((e) => e.type)).toEqual([
      'REATTEST_STARTED',
      ...a.items.map(() => 'ITEM_ATTESTED'),
      'SIGNED_OFF',
    ]);
    expect(events[0].payload).toMatchObject({ bindingId: B, toVersion: 4, items: a.items.length });
    expect(events[events.length - 1].payload).toMatchObject({ bindingId: B, toVersion: 4 });
    expect(verifyChain(events).ok).toBe(true);
  });
});
