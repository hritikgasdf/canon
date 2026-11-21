import { describe, expect, it, vi } from 'vitest';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import type { SampleDeps } from '../src/domain/sampleData';
import {
  loadSampleHandler,
  sampleStateHandler,
  saveSettingsHandler,
  setupChecksHandler,
  type AdminDeps,
} from '../src/forge/adminResolver';

function mk(isAdmin = true, over: Partial<AdminDeps> = {}) {
  const repos = createMemoryRepos();
  const deps: AdminDeps = {
    isAdmin: async () => isAdmin,
    repos,
    setup: { repos, confluenceReachable: async () => true, pageReadable: async () => true, now: () => 'x' },
    sample: { repos } as unknown as SampleDeps,
    ...over,
  };
  return { repos, deps };
}
const NOT_ADMIN = { ok: false, error: 'NOT_ADMIN', message: 'Only Jira administrators can use Canon setup.' };
const good = { validatorMode: 'warn', revisionPolicy: 'every-major', autoBind: { 'PROJ/Task': '123', Bug: '45' } };

describe('admin guard', () => {
  it('rejects non-admins on every handler', async () => {
    const { deps } = mk(false);
    expect(await setupChecksHandler({}, deps)).toEqual(NOT_ADMIN);
    expect(await sampleStateHandler({}, deps)).toEqual(NOT_ADMIN);
    expect(await loadSampleHandler({ payload: { spaceKey: 'AB', projectKey: 'CD' } }, deps)).toEqual(NOT_ADMIN);
    expect(await saveSettingsHandler({ payload: good }, deps)).toEqual(NOT_ADMIN);
  });
  it('treats a throwing isAdmin as non-admin', async () => {
    const { deps } = mk(true, {
      isAdmin: async () => {
        throw new Error('x');
      },
    });
    expect(await sampleStateHandler({}, deps)).toEqual(NOT_ADMIN);
  });
  it('admin gets setup checks and null sample state', async () => {
    const { deps } = mk();
    const r = await setupChecksHandler({}, deps);
    expect(r.ok && 'checks' in r && r.checks.length).toBe(6);
    expect(await sampleStateHandler({}, deps)).toEqual({ ok: true, sample: null });
  });
  it('internal errors are generic and logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { repos, deps } = mk();
    repos.sample.get = async () => {
      throw new Error('secret');
    };
    expect(await sampleStateHandler({}, deps)).toEqual({
      ok: false,
      error: 'INTERNAL',
      message: 'Something went wrong. Try again.',
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('canonLoadSample validation', () => {
  it.each([
    [{ spaceKey: 'a', projectKey: 'CD' }],
    [{ spaceKey: 'AB', projectKey: 'c-d' }],
    [{ spaceKey: 'AB' }],
    [{ spaceKey: 'AB', projectKey: 'X'.repeat(21) }],
    [undefined],
  ])('rejects %j', async (payload) => {
    const r = await loadSampleHandler({ payload, context: { accountId: 'u1' } }, mk().deps);
    expect(r).toMatchObject({ ok: false, error: 'INVALID_INPUT' });
  });
});

describe('canonSaveSettings validation', () => {
  it('saves valid settings merged over existing', async () => {
    const { repos, deps } = mk();
    expect((await saveSettingsHandler({ payload: good }, deps)).ok).toBe(true);
    expect(await repos.settings.get()).toMatchObject({
      validatorMode: 'warn',
      revisionPolicy: 'every-major',
      autoBind: good.autoBind,
      requireIndependentApprover: true,
    });
  });
  it.each([
    [{ ...good, validatorMode: 'off' }],
    [{ ...good, revisionPolicy: 'x' }],
    [{ ...good, autoBind: { 'PROJ/Task': 'abc' } }],
    [{ ...good, autoBind: { 'bad key!': '1' } }],
    [{ ...good, autoBind: ['1'] }],
    [{ ...good, autoBind: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`T${i}`, '1'])) }],
  ])('rejects %j without saving', async (payload) => {
    const { repos, deps } = mk();
    expect(await saveSettingsHandler({ payload }, deps)).toMatchObject({ ok: false, error: 'INVALID_INPUT' });
    expect((await repos.settings.get()).validatorMode).toBe('block');
  });
});
