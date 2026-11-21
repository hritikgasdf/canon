import { describe, expect, it } from 'vitest';
import { isNewerVersion } from '../src/domain/version';

describe('isNewerVersion', () => {
  it('returns true when current is greater than bound', () => {
    expect(isNewerVersion(3, 2)).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isNewerVersion(2, 2)).toBe(false);
  });

  it('returns false when current is older than bound', () => {
    expect(isNewerVersion(1, 4)).toBe(false);
  });

  it('throws on non-positive or non-integer input', () => {
    expect(() => isNewerVersion(0, 1)).toThrow(RangeError);
    expect(() => isNewerVersion(1, -1)).toThrow(RangeError);
    expect(() => isNewerVersion(1.5, 1)).toThrow(RangeError);
    expect(() => isNewerVersion(2, Number.NaN)).toThrow(RangeError);
  });
});
