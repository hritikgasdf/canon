import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import type { Repos } from '../src/domain/repos';
import type { BodyFetcher } from '../src/domain/supersede';
import type { Binding, Procedure } from '../src/domain/types';
import {
  attestationHandler,
  attestItemHandler,
  attestSignHandler,
  attestStartHandler,
  type AttestDeps,
} from '../src/forge/attestResolver';

const seed = (v: number): string => readFileSync(`seed/sop-pay-014/v${v}.xhtml`, 'utf8');
const bodies: Record<number, string> = { 3: seed(3), 4: seed(4) };
const B = 'CHG-1.p1';

async function setup(canViewResult = true) {
  const repos: Repos = createMemoryRepos();
  const procedure: Procedure = {
    pageId: 'p1',
    title: 'T',
    controlled: true,
    policy: 'approved-only',
    approved: [],
    currentApproved: 4,
    lastSeenVersion: 4,
  };
  const binding: Binding = {
    id: B,
    issueKey: 'CHG-1',
    pageId: 'p1',
    boundVersion: 3,
    boundAt: 't',
    boundBy: 'u',
    state: 'SUPERSEDED',
    supersededBy: 4,
  };
  await repos.procedures.put(procedure);
  await repos.bindings.put(binding);
  const deps: AttestDeps = {
    repos,
    canView: vi.fn(async () => canViewResult),
    fetchBody: vi.fn<BodyFetcher>(async (_p, v) => bodies[v]),
    now: () => '2026-01-01T00:00:00.000Z',
  };
  return { repos, deps };
}

const req = (
  accountId: string | undefined,
  payload: Record<string, unknown> = { bindingId: B },
  issue: string | undefined = 'CHG-1',
) => ({
  context: { accountId, extension: { issue: issue ? { key: issue } : undefined } },
  payload,
});

describe('attest resolvers', () => {
  it('requires issue and account context', async () => {
    const { deps } = await setup();
    expect(await attestStartHandler(req(undefined), deps)).toMatchObject({ ok: false, error: 'NO_CONTEXT' });
    expect(await attestStartHandler(req('u1', { bindingId: B }, ''), deps)).toMatchObject({ error: 'NO_CONTEXT' });
  });

  it('binding on another issue is NOT_FOUND', async () => {
    const { deps } = await setup();
    expect(await attestStartHandler(req('u1', { bindingId: B }, 'OTHER-1'), deps)).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('NO_ACCESS never mutates', async () => {
    const { repos, deps } = await setup(false);
    for (const h of [attestStartHandler, attestSignHandler, attestItemHandler, attestationHandler]) {
      expect(await h(req('u1', { bindingId: B, itemId: 'x', action: 'DONE' }), deps)).toMatchObject({
        ok: false,
        error: 'NO_ACCESS',
      });
    }
    expect((await repos.bindings.get(B))!.state).toBe('SUPERSEDED');
    expect(await repos.attestations.get(B, 4)).toBeNull();
    expect(await repos.audit.list('CHG-1')).toHaveLength(0);
  });

  it('ignores an actor in the payload', async () => {
    const { repos, deps } = await setup();
    const r = await attestStartHandler(req('real-user', { bindingId: B, actor: 'spoofed' }), deps);
    expect(r).toMatchObject({ ok: true });
    expect((await repos.attestations.get(B, 4))!.implementer).toBe('real-user');
    expect((await repos.audit.list('CHG-1'))[0].actor).toBe('real-user');
  });

  it('happy path: start, attest, sign with a different user; SoD enforced', async () => {
    const { repos, deps } = await setup();
    const started = await attestStartHandler(req('impl'), deps);
    if (!started.ok || !started.attestation) throw new Error('start failed');
    for (const i of started.attestation.items) {
      const r = await attestItemHandler(
        req('impl', { bindingId: B, itemId: i.itemId, action: 'DONE', note: 'implemented' }),
        deps,
      );
      expect(r).toMatchObject({ ok: true });
    }
    expect(await attestSignHandler(req('impl'), deps)).toMatchObject({ ok: false, error: 'SELF_SIGN' });
    const signed = await attestSignHandler(req('qa', { bindingId: B, actor: 'impl' }), deps);
    expect(signed).toMatchObject({ ok: true });
    expect((await repos.bindings.get(B))!.state).toBe('CLEARED');
    const got = await attestationHandler(req('qa'), deps);
    expect(got.ok && got.attestation?.sealHash).toBeTruthy();
  });

  it('rejects bad item payloads with a code', async () => {
    const { deps } = await setup();
    await attestStartHandler(req('impl'), deps);
    expect(
      await attestItemHandler(req('impl', { bindingId: B, itemId: 'x', action: 'WHATEVER' }), deps),
    ).toMatchObject({ error: 'INVALID_ACTION' });
  });
});
