import { describe, expect, it } from 'vitest';
import { evaluateGate, FAIL_CLOSED_MESSAGE, parseBinding } from '../src/domain/gate';

const binding = { pageId: '123', boundVersion: 3, title: 'Deploy SOP' };

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
