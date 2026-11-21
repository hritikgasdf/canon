import { describe, expect, it } from 'vitest';
import type { GateDecision } from '../src/domain/gateEval';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import { createThrottledHeartbeat, runGate, type GateDeps } from '../src/forge/gate';

const args = { issue: { key: 'CAN-1' } };
type D = GateDecision & { bindingCount: number };
const allow: D = { allow: true, warnOnly: false, reasons: [], bindingCount: 1 };
const block: D = {
  allow: false,
  warnOnly: false,
  reasons: [{ pageId: '1', title: 'SOP', code: 'SUPERSEDED', boundVersion: 3, targetVersion: 4 }],
  message: 'Canon: blocked',
  bindingCount: 1,
};

function deps(over: Partial<GateDeps> = {}): GateDeps {
  return { gate: async () => allow, now: () => Date.now(), log: () => undefined, ...over };
}

describe('runGate heartbeat', () => {
  it('passes the outcome to the heartbeat', async () => {
    const seen: unknown[] = [];
    await runGate(args, deps({ gate: async () => block, heartbeat: async (h) => void seen.push(h) }));
    expect(seen).toMatchObject([{ issueKey: 'CAN-1', outcome: 'block' }]);
  });
  it('a rejecting heartbeat does not change the result', async () => {
    const heartbeat = async () => {
      throw new Error('kvs down');
    };
    expect(await runGate(args, deps({ heartbeat }))).toEqual({ result: true });
  });
  it('a synchronously throwing heartbeat does not change a block', async () => {
    const heartbeat = () => {
      throw new Error('boom');
    };
    expect(await runGate(args, deps({ gate: async () => block, heartbeat }))).toEqual({
      result: false,
      errorMessage: 'Canon: blocked',
    });
  });
  it('throttle skips when the previous heartbeat is under 10 minutes old', async () => {
    const repos = createMemoryRepos();
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    let now = t0;
    const beat = createThrottledHeartbeat(repos.gateHeartbeat, () => now);
    await beat({ at: new Date(t0).toISOString(), issueKey: 'A-1', outcome: 'allow' });
    now = t0 + 5 * 60_000;
    await beat({ at: new Date(now).toISOString(), issueKey: 'A-2', outcome: 'allow' });
    expect((await repos.gateHeartbeat.get())?.issueKey).toBe('A-1');
    now = t0 + 11 * 60_000;
    await beat({ at: new Date(now).toISOString(), issueKey: 'A-3', outcome: 'block' });
    expect((await repos.gateHeartbeat.get())?.issueKey).toBe('A-3');
  });
});
