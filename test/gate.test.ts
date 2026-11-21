import { describe, expect, it } from 'vitest';
import { evaluateGate, FAIL_CLOSED_MESSAGE, parseBinding } from '../src/domain/gate';
import { runGate, type GateDeps } from '../src/forge/gate';

const binding = { pageId: '123', boundVersion: 3, title: 'Deploy SOP' };
const args = { issue: { key: 'CAN-1' } };

function deps(over: Partial<GateDeps> = {}): GateDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    getBinding: async () => binding,
    getPageVersion: async () => 3,
    now: () => Date.now(),
    log: (l) => lines.push(l),
    ...over,
  };
}

const boom = async (): Promise<never> => {
  throw new Error('boom');
};

describe('parseBinding', () => {
  it('accepts valid', () => {
    expect(parseBinding(binding)).toEqual(binding);
  });
  it.each([
    null,
    'x',
    [],
    {},
    { pageId: '', boundVersion: 1 },
    { pageId: 'abc', boundVersion: 1 },
    { pageId: 123, boundVersion: 1 },
    { pageId: '1', boundVersion: 0 },
    { pageId: '1', boundVersion: 1.5 },
    { pageId: '1', boundVersion: '2' },
  ])('rejects %j', (v) => {
    expect(() => parseBinding(v)).toThrow();
  });
});

describe('evaluateGate', () => {
  it('allows without binding', () => {
    expect(evaluateGate({ issueKey: 'CAN-1', binding: null, currentVersion: null })).toEqual({ result: true });
  });
  it('allows current', () => {
    expect(evaluateGate({ issueKey: 'CAN-1', binding, currentVersion: 3 }).result).toBe(true);
  });
  it('blocks superseded', () => {
    const r = evaluateGate({ issueKey: 'CAN-1', binding, currentVersion: 4 });
    expect(r.result).toBe(false);
    expect(r.errorMessage).toContain('v3 → v4');
    expect(r.errorMessage).toContain('"Deploy SOP"');
  });
  it('uses page id when no title', () => {
    const r = evaluateGate({ issueKey: 'CAN-1', binding: { pageId: '9', boundVersion: 1 }, currentVersion: 2 });
    expect(r.errorMessage).toContain('"page 9"');
  });
  it.each([null, 0, -1, 1.5, NaN])('fails closed on bad version %s', (v) => {
    expect(evaluateGate({ issueKey: 'CAN-1', binding, currentVersion: v })).toEqual({
      result: false,
      errorMessage: FAIL_CLOSED_MESSAGE,
    });
  });
});

describe('runGate', () => {
  it('allows with no binding', async () => {
    const d = deps({ getBinding: async () => null });
    expect(await runGate(args, d)).toEqual({ result: true });
    expect(JSON.parse(d.lines[0]).reason).toBe('no-binding');
  });
  it('allows current', async () => {
    expect((await runGate(args, deps())).result).toBe(true);
  });
  it('blocks superseded', async () => {
    const d = deps({ getPageVersion: async () => 4 });
    const r = await runGate(args, d);
    expect(r.result).toBe(false);
    expect(r.errorMessage).toContain('v3 → v4');
    expect(JSON.parse(d.lines[0]).reason).toBe('superseded');
  });
  it('forceError blocks', async () => {
    const r = await runGate(args, deps({ getBinding: async () => ({ ...binding, forceError: true }) }));
    expect(r).toEqual({ result: false, errorMessage: FAIL_CLOSED_MESSAGE });
  });
  it('invalid binding blocks', async () => {
    const r = await runGate(args, deps({ getBinding: async () => ({ pageId: 'x' }) }));
    expect(r.errorMessage).toBe(FAIL_CLOSED_MESSAGE);
  });
  it('getBinding throws blocks', async () => {
    const r = await runGate(args, deps({ getBinding: boom }));
    expect(r).toEqual({ result: false, errorMessage: FAIL_CLOSED_MESSAGE });
  });
  it('getPageVersion throws blocks', async () => {
    const r = await runGate(args, deps({ getPageVersion: boom }));
    expect(r).toEqual({ result: false, errorMessage: FAIL_CLOSED_MESSAGE });
  });
  it('bad page version blocks', async () => {
    const r = await runGate(args, deps({ getPageVersion: async () => undefined as unknown as number }));
    expect(r.errorMessage).toBe(FAIL_CLOSED_MESSAGE);
  });
  it('timeout blocks', async () => {
    const d = deps({ getPageVersion: () => new Promise<number>(() => undefined), timeoutMs: 20 });
    const r = await runGate(args, d);
    expect(r).toEqual({ result: false, errorMessage: FAIL_CLOSED_MESSAGE });
    expect(JSON.parse(d.lines[0]).error).toContain('timeout');
  });
  it('missing issue key blocks', async () => {
    expect((await runGate({}, deps())).errorMessage).toBe(FAIL_CLOSED_MESSAGE);
    expect((await runGate(undefined, deps())).result).toBe(false);
  });
  it('logs valid JSON line', async () => {
    const d = deps();
    await runGate(args, d);
    expect(d.lines).toHaveLength(1);
    const j = JSON.parse(d.lines[0]);
    expect(j).toMatchObject({
      tag: 'canon-gate',
      issueKey: 'CAN-1',
      result: true,
      reason: 'current',
      boundVersion: 3,
      currentVersion: 3,
    });
    expect(typeof j.totalMs).toBe('number');
  });
});
