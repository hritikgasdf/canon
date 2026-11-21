import { describe, expect, it } from 'vitest';
import { GATE_FAIL_CLOSED, type GateDecision } from '../src/domain/gateEval';
import { runGate, type GateDeps } from '../src/forge/gate';

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

function deps(over: Partial<GateDeps> = {}): GateDeps & { lines: string[] } {
  const lines: string[] = [];
  return { lines, gate: async () => allow, now: () => Date.now(), log: (l) => lines.push(l), ...over };
}

describe('runGate', () => {
  it('allows and logs no-binding when bindingCount is 0', async () => {
    const d = deps({ gate: async () => ({ ...allow, bindingCount: 0 }) });
    expect(await runGate(args, d)).toEqual({ result: true });
    expect(JSON.parse(d.lines[0] as string).reason).toBe('no-binding');
  });
  it('maps allow', async () => {
    const d = deps();
    expect(await runGate(args, d)).toEqual({ result: true });
    expect(JSON.parse(d.lines[0] as string)).toMatchObject({ tag: 'canon-gate', reason: 'allow', bindingCount: 1 });
  });
  it('maps warn-only allow', async () => {
    const d = deps({ gate: async () => ({ ...block, allow: true, warnOnly: true }) });
    expect(await runGate(args, d)).toEqual({ result: true });
    expect(JSON.parse(d.lines[0] as string).reason).toBe('warn');
  });
  it('maps block with message and codes', async () => {
    const d = deps({ gate: async () => block });
    expect(await runGate(args, d)).toEqual({ result: false, errorMessage: 'Canon: blocked' });
    expect(JSON.parse(d.lines[0] as string)).toMatchObject({ reason: 'block', codes: ['SUPERSEDED'], issueKey: 'CAN-1' });
  });
  it('block without message fails closed message', async () => {
    const r = await runGate(args, deps({ gate: async () => ({ ...block, message: undefined }) }));
    expect(r).toEqual({ result: false, errorMessage: GATE_FAIL_CLOSED });
  });
  it('fails closed when gate throws', async () => {
    const d = deps({
      gate: async () => {
        throw new Error('boom');
      },
    });
    expect(await runGate(args, d)).toEqual({ result: false, errorMessage: GATE_FAIL_CLOSED });
    expect(JSON.parse(d.lines[0] as string)).toMatchObject({ reason: 'error', error: 'boom' });
  });
  it('fails closed on timeout', async () => {
    const d = deps({ gate: () => new Promise<D>(() => undefined), timeoutMs: 20 });
    expect(await runGate(args, d)).toEqual({ result: false, errorMessage: GATE_FAIL_CLOSED });
    expect(JSON.parse(d.lines[0] as string).error).toContain('timeout');
  });
  it('fails closed on missing issue key', async () => {
    expect((await runGate({}, deps())).errorMessage).toBe(GATE_FAIL_CLOSED);
    expect((await runGate(undefined, deps())).result).toBe(false);
  });
  it('log failure never changes the outcome', async () => {
    const log = (): void => {
      throw new Error('log down');
    };
    expect(await runGate(args, deps({ log }))).toEqual({ result: true });
    expect(await runGate(args, deps({ log, gate: async () => block }))).toEqual({
      result: false,
      errorMessage: 'Canon: blocked',
    });
  });
});
