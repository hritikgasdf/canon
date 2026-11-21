import { describe, expect, it } from 'vitest';
import { summarizeIssue } from '../src/domain/issueSummary';
import type { Binding, BindingState } from '../src/domain/types';

function b(id: string, state: BindingState, over: Partial<Binding> = {}): Binding {
  return {
    id,
    issueKey: 'CAN-1',
    pageId: `page-${id}`,
    boundVersion: 3,
    boundAt: '2026-01-01T00:00:00.000Z',
    boundBy: 'acc-1',
    state,
    ...over,
  };
}

describe('summarizeIssue', () => {
  it('returns NONE with no bindings', () => {
    expect(summarizeIssue([])).toEqual({
      state: 'NONE',
      bindingCount: 0,
      boundVersion: null,
      targetVersion: null,
      pageIds: [],
    });
  });

  it('reports CURRENT for a single current binding with no target version', () => {
    expect(summarizeIssue([b('a', 'CURRENT', { boundVersion: 5 })])).toEqual({
      state: 'CURRENT',
      bindingCount: 1,
      boundVersion: 5,
      targetVersion: null,
      pageIds: ['page-a'],
    });
  });

  it('ranks ORPHANED above SUPERSEDED, REATTESTING, CURRENT and CLEARED', () => {
    const s = summarizeIssue([
      b('a', 'CURRENT'),
      b('b', 'CLEARED'),
      b('c', 'REATTESTING', { boundVersion: 4 }),
      b('d', 'ORPHANED', { boundVersion: 7 }),
      b('e', 'SUPERSEDED', { boundVersion: 2, supersededBy: 9 }),
    ]);
    expect(s.state).toBe('ORPHANED');
    expect(s.boundVersion).toBe(7);
    expect(s.targetVersion).toBeNull();
    expect(s.bindingCount).toBe(5);
  });

  it('takes boundVersion and targetVersion (supersededBy) from the SUPERSEDED binding that decides', () => {
    const s = summarizeIssue([
      b('a', 'CURRENT', { boundVersion: 10 }),
      b('b', 'SUPERSEDED', { boundVersion: 3, supersededBy: 4 }),
      b('c', 'REATTESTING', { boundVersion: 8 }),
    ]);
    expect(s).toMatchObject({ state: 'SUPERSEDED', boundVersion: 3, targetVersion: 4, bindingCount: 3 });
  });

  it('ranks REATTESTING above CURRENT and CLEARED, and CLEARED is the lowest', () => {
    expect(summarizeIssue([b('a', 'CLEARED'), b('b', 'CURRENT')]).state).toBe('CURRENT');
    expect(summarizeIssue([b('a', 'CURRENT', { boundVersion: 2 }), b('b', 'REATTESTING', { boundVersion: 6 })])).toMatchObject({
      state: 'REATTESTING',
      boundVersion: 6,
      targetVersion: null,
    });
    expect(summarizeIssue([b('a', 'CLEARED', { boundVersion: 1 })]).state).toBe('CLEARED');
  });

  it('lists each pageId once, in first-seen order', () => {
    const s = summarizeIssue([
      b('a', 'CURRENT', { pageId: 'P1' }),
      b('b', 'CURRENT', { pageId: 'P2' }),
      b('c', 'SUPERSEDED', { pageId: 'P1', supersededBy: 5 }),
    ]);
    expect(s.pageIds).toEqual(['P1', 'P2']);
  });
});
