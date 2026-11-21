import { describe, expect, it } from 'vitest';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import { runSetupChecks, type SetupDeps } from '../src/domain/setupChecks';
import type { Procedure } from '../src/domain/types';

const proc = (pageId: string): Procedure =>
  ({
    pageId,
    title: `P${pageId}`,
    controlled: true,
    currentApproved: 1,
    lastSeenVersion: 1,
    policy: 'approved-only',
  }) as unknown as Procedure;

function mk(over: Partial<SetupDeps> = {}) {
  const repos = createMemoryRepos();
  const deps: SetupDeps = {
    repos,
    confluenceReachable: async () => true,
    pageReadable: async () => true,
    now: () => '2026-01-01T00:00:00Z',
    ...over,
  };
  return { repos, deps };
}
const get = async (deps: SetupDeps, id: string) => {
  const c = (await runSetupChecks(deps)).checks.find((x) => x.id === id);
  if (!c) throw new Error('missing check');
  return c;
};

describe('runSetupChecks', () => {
  it('returns all six checks', async () => {
    const { deps } = mk();
    expect((await runSetupChecks(deps)).checks.map((c) => c.id)).toEqual([
      'confluence',
      'space-access',
      'gate',
      'policy',
      'auto-bind',
      'procedures',
    ]);
  });
  it('confluence ok / fail', async () => {
    expect((await get(mk().deps, 'confluence')).status).toBe('ok');
    const c = await get(mk({ confluenceReachable: async () => false }).deps, 'confluence');
    expect(c.status).toBe('fail');
    expect(c.fix).toContain('Install Canon in Confluence');
  });
  it('space-access warns with no controlled procedures', async () => {
    const c = await get(mk().deps, 'space-access');
    expect(c.status).toBe('warn');
    expect(c.detail).toBe('No controlled procedures yet');
  });
  it('space-access ok when all readable', async () => {
    const { repos, deps } = mk();
    await repos.procedures.put(proc('1'));
    await repos.procedures.put(proc('2'));
    expect(await get(deps, 'space-access')).toMatchObject({ status: 'ok', detail: '2 controlled procedures readable' });
  });
  it('space-access fails listing unreadable pages', async () => {
    const { repos, deps } = mk({ pageReadable: async (id) => id !== '2' });
    await repos.procedures.put(proc('1'));
    await repos.procedures.put(proc('2'));
    const c = await get(deps, 'space-access');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('2');
    expect(c.fix).toContain('Space settings');
  });
  it('gate warns with no heartbeat and is ok with one', async () => {
    const { repos, deps } = mk();
    expect((await get(deps, 'gate')).status).toBe('warn');
    await repos.gateHeartbeat.put({ at: '2026-01-01T00:00:00Z', issueKey: 'CAN-1', outcome: 'allow' });
    expect(await get(deps, 'gate')).toMatchObject({
      status: 'ok',
      detail: 'Canon gate last ran 2026-01-01T00:00:00Z on CAN-1',
    });
  });
  it('policy ok by default, warn in warn mode', async () => {
    const { repos, deps } = mk();
    expect(await get(deps, 'policy')).toMatchObject({
      status: 'ok',
      detail: 'Revision policy approved-only; validator mode block; independent approver on',
    });
    await repos.settings.put({ ...(await repos.settings.get()), validatorMode: 'warn' });
    expect(await get(deps, 'policy')).toMatchObject({ status: 'warn', fix: 'Switch to Block to enforce' });
  });
  it('auto-bind: empty warns, mapped ok, orphan warns', async () => {
    const { repos, deps } = mk();
    expect(await get(deps, 'auto-bind')).toMatchObject({ status: 'warn', detail: 'No auto-bind mappings' });
    await repos.procedures.put(proc('10'));
    const s = await repos.settings.get();
    await repos.settings.put({ ...s, autoBind: { 'PROJ/Task': '10' } });
    expect(await get(deps, 'auto-bind')).toMatchObject({ status: 'ok', detail: 'PROJ/Task → 10' });
    await repos.settings.put({ ...s, autoBind: { 'PROJ/Task': '10', Bug: '99' } });
    expect((await get(deps, 'auto-bind')).status).toBe('warn');
  });
  it('procedures is ok even with zero', async () => {
    expect((await get(mk().deps, 'procedures')).status).toBe('ok');
  });
  it('dep errors fail only that check, without raw error text', async () => {
    const { repos, deps } = mk({
      confluenceReachable: async () => {
        throw new Error('secret-token-xyz');
      },
    });
    repos.gateHeartbeat.get = async () => {
      throw new Error('secret-token-xyz');
    };
    const { checks } = await runSetupChecks(deps);
    for (const id of ['confluence', 'gate']) {
      expect(checks.find((x) => x.id === id)).toMatchObject({ status: 'fail', detail: 'Could not check (error)' });
    }
    expect(JSON.stringify(checks)).not.toContain('secret-token');
    expect(checks.find((c) => c.id === 'policy')?.status).toBe('ok');
  });
});
