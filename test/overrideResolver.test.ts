import { describe, expect, it, vi } from 'vitest';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import { breakGlassHandler, type OverrideDeps } from '../src/forge/overrideResolver';

const REASON = 'Production incident, approved by CAB';

async function setup(admin: boolean) {
  const repos = createMemoryRepos();
  await repos.bindings.put({
    id: 'b1',
    issueKey: 'CHG-1',
    pageId: 'p1',
    boundVersion: 3,
    boundAt: 't',
    boundBy: 'u',
    state: 'SUPERSEDED',
    supersededBy: 4,
  });
  const isProjectAdmin = vi.fn<OverrideDeps['isProjectAdmin']>(async () => admin);
  const deps: OverrideDeps = { repos, canView: async () => true, isProjectAdmin, now: () => '2026-01-01T00:00:00Z' };
  return { repos, deps, isProjectAdmin };
}

const req = (payload: unknown) => ({
  context: { accountId: 'acc1', extension: { issue: { key: 'CHG-1' } } },
  payload,
});

describe('breakGlassHandler', () => {
  it('payload cannot claim admin', async () => {
    const { deps, repos } = await setup(false);
    const r = await breakGlassHandler(req({ bindingId: 'b1', reason: REASON, isProjectAdmin: true }), deps);
    expect(r).toMatchObject({ ok: false, error: 'NOT_ADMIN' });
    expect((await repos.bindings.get('b1'))?.override).toBeUndefined();
  });
  it('fails closed when the admin check throws', async () => {
    const { deps } = await setup(true);
    deps.isProjectAdmin = async () => {
      throw new Error('boom');
    };
    expect(await breakGlassHandler(req({ bindingId: 'b1', reason: REASON }), deps)).toMatchObject({
      error: 'NOT_ADMIN',
    });
  });
  it('happy path uses the context actor and the issue project key', async () => {
    const { deps, repos, isProjectAdmin } = await setup(true);
    const r = await breakGlassHandler(req({ bindingId: 'b1', reason: REASON, actor: 'evil' }), deps);
    expect(r).toEqual({ ok: true, overridden: true });
    expect(isProjectAdmin).toHaveBeenCalledWith('CHG');
    expect((await repos.bindings.get('b1'))?.override?.by).toBe('acc1');
  });
  it('requires context and access', async () => {
    const { deps } = await setup(true);
    expect(await breakGlassHandler({ payload: {} }, deps)).toMatchObject({ error: 'NO_CONTEXT' });
    deps.canView = async () => false;
    expect(await breakGlassHandler(req({ bindingId: 'b1', reason: REASON }), deps)).toMatchObject({
      error: 'NO_ACCESS',
    });
  });
});
