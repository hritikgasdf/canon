import { describe, expect, it } from 'vitest';
import { needsReattestation } from '../src/domain/panelLogic';

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
