import { describe, expect, it } from 'vitest';
import { askCanonPrompt, needsReattestation, showAskCanon } from '../src/domain/panelLogic';

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
