import { describe, expect, it, vi } from 'vitest';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import { registerHandler, registerVerifyHandler, type RegisterResolverDeps } from '../src/forge/registerResolver';

const NO_ACCESS = { ok: false, error: 'NO_ACCESS', message: 'You do not have access to this project.' };
const req = (key?: string, payload?: unknown) => ({
  context: { extension: { project: key ? { key } : undefined } },
  payload,
});

async function mk(browse = true) {
  const repos = createMemoryRepos();
  await repos.procedures.put({
    pageId: '1', title: 'P', controlled: true, policy: 'approved-only', approved: [], currentApproved: 2, lastSeenVersion: 2,
  });
  for (const issueKey of ['CHG-1', 'OPS-1']) {
    await repos.bindings.put({
      id: issueKey, issueKey, pageId: '1', boundVersion: 2, boundAt: 'x', boundBy: 'a', state: 'CURRENT',
    });
  }
  const canBrowseProject = vi.fn(async () => browse);
  const deps: RegisterResolverDeps = { repos, canBrowseProject, canView: async () => true };
  return { deps, canBrowseProject };
}

describe('register resolvers', () => {
  it('returns NO_ACCESS without project context', async () => {
    const { deps } = await mk();
    expect(await registerHandler(req(), deps)).toEqual(NO_ACCESS);
    expect(await registerVerifyHandler(req(), deps)).toEqual(NO_ACCESS);
  });

  it('returns NO_ACCESS when the user cannot browse the project', async () => {
    const { deps } = await mk(false);
    expect(await registerHandler(req('CHG'), deps)).toEqual(NO_ACCESS);
    expect(await registerVerifyHandler(req('CHG'), deps)).toEqual(NO_ACCESS);
  });

  it('ignores a payload projectKey', async () => {
    const { deps, canBrowseProject } = await mk();
    const r = await registerHandler(req('CHG', { projectKey: 'OPS' }), deps);
    expect(canBrowseProject).toHaveBeenCalledWith('CHG');
    expect(r.ok && r.register.rows.map((x) => x.issueKey)).toEqual(['CHG-1']);
    const v = await registerVerifyHandler(req('CHG', { issueKeys: ['OPS-1'] }), deps);
    expect(v.ok && v.verification.checked).toBe(1);
  });

  it('returns the register and verification on the ok path', async () => {
    const { deps } = await mk();
    const r = await registerHandler(req('OPS'), deps);
    expect(r).toMatchObject({ ok: true, register: { projectKey: 'OPS', counts: { CURRENT: 1 } } });
    const v = await registerVerifyHandler(req('OPS'), deps);
    expect(v).toMatchObject({ ok: true, verification: { allOk: true, checked: 1 } });
  });

  it('maps internal errors to a generic message', async () => {
    const { deps } = await mk();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    deps.repos.procedures.listControlled = async () => {
      throw new Error('secret detail');
    };
    expect(await registerHandler(req('CHG'), deps)).toEqual({
      ok: false, error: 'INTERNAL', message: 'Something went wrong. Try again.',
    });
    spy.mockRestore();
  });
});
