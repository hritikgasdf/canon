import { describe, expect, it } from 'vitest';
import {
  askCanonPrompt,
  needsReattestation,
  askPollPlan,
  idlePollPlan,
  REFRESH_ON_SELECT_TABS,
  shouldPollTick,
  shouldRefreshOnFocus,
  showAskCanon,
  viewSignature,
} from '../src/domain/panelLogic';

describe('needsReattestation', () => {
  it('is false with no bindings', () => expect(needsReattestation([])).toBe(false));
  it('is true for a visible SUPERSEDED or REATTESTING binding', () => {
    expect(needsReattestation([{ restricted: false, state: 'SUPERSEDED' }])).toBe(true);
    expect(needsReattestation([{ restricted: false, state: 'REATTESTING' }])).toBe(true);
  });
  it('ignores restricted bindings', () =>
    expect(needsReattestation([{ restricted: true, state: 'SUPERSEDED' }])).toBe(false));
  it('is false for CURRENT, CLEARED and ORPHANED', () =>
    expect(
      needsReattestation([
        { restricted: false, state: 'CURRENT' },
        { restricted: false, state: 'CLEARED' },
        { restricted: false, state: 'ORPHANED' },
      ]),
    ).toBe(false));
});

describe('Ask Canon', () => {
  it('asks what to redo when re-attestation is needed', () => {
    expect(askCanonPrompt('CHG-12', true)).toBe('What changed in my procedure for CHG-12 and what do I need to redo?');
  });
  it('asks whether the item is clear to close otherwise', () => {
    expect(askCanonPrompt('CHG-12', false)).toBe('Is CHG-12 clear to close?');
  });
  it('is offered whenever the item has a binding, including after sign-off', () => {
    expect(showAskCanon(0)).toBe(false);
    expect(showAskCanon(1)).toBe(true);
  });
});

describe('panel refresh', () => {
  it('signature changes when a binding state changes', () => {
    const a = viewSignature([{ id: 'b1', state: 'SUPERSEDED' }]);
    expect(viewSignature([{ id: 'b1', state: 'REATTESTING' }])).not.toBe(a);
    expect(viewSignature([{ id: 'b1', state: 'SUPERSEDED' }])).toBe(a);
  });
  it('after Ask Canon polls every 7 s for 5 min', () => {
    expect(askPollPlan(1000)).toEqual({ intervalMs: 7000, until: 1000 + 300000 });
  });
  it('watches lightly only while a visible binding is SUPERSEDED (no re-attestation started)', () => {
    expect(idlePollPlan([{ restricted: false, state: 'SUPERSEDED' }], 0)).toEqual({ intervalMs: 20000, until: 600000 });
    expect(idlePollPlan([{ restricted: false, state: 'REATTESTING' }], 0)).toBeNull();
    expect(idlePollPlan([{ restricted: true, state: 'SUPERSEDED' }], 0)).toBeNull();
    expect(idlePollPlan([{ restricted: false, state: 'CURRENT' }], 0)).toBeNull();
  });
  it('reads while visible, skips while hidden, stops after the window or with no plan', () => {
    const plan = { intervalMs: 7000, until: 100 };
    expect(shouldPollTick(plan, 50, false)).toBe('read');
    expect(shouldPollTick(plan, 50, true)).toBe('skip');
    expect(shouldPollTick(plan, 101, false)).toBe('stop');
    expect(shouldPollTick(null, 0, false)).toBe('stop');
  });
  it('refetches when the Attest or Evidence tab is selected, not Status or Delta', () => {
    expect(REFRESH_ON_SELECT_TABS).toEqual([2, 3]);
  });
  it('throttles focus refreshes to one per 10 s', () => {
    expect(shouldRefreshOnFocus(0, 9999)).toBe(false);
    expect(shouldRefreshOnFocus(0, 10000)).toBe(true);
  });
});
