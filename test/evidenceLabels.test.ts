import { describe, expect, it } from 'vitest';
import { actorIds, actorLabel, eventLabel } from '../src/domain/evidenceLabels';

const ev = (type: string, actor: string, payload: Record<string, unknown> = {}) => ({ type, actor, payload }) as never;

describe('actorLabel', () => {
  it('formats sample personas', () => {
    expect(actorLabel('sample:priya-nair')).toBe('Priya Nair (sample)');
    expect(actorLabel('sample:arjun-mehta')).toBe('Arjun Mehta (sample)');
    expect(actorLabel('sample:lena-ortiz')).toBe('Lena Ortiz (sample)');
  });
  it('formats canon actors', () => {
    expect(actorLabel('canon:auto-bind')).toBe('Canon (auto-bind)');
    expect(actorLabel('canon:system')).toBe('Canon (system)');
    expect(actorLabel('canon:x')).toBe('Canon (x)');
  });
  it('never returns a raw account id', () => {
    expect(actorLabel('5b10ac8d82e05b22cc7d4ef5')).toBe('Unknown user');
  });
  it('uses a known display name', () => {
    expect(actorLabel('abc123', { abc123: 'Dana Lee' })).toBe('Dana Lee');
  });
});

describe('actorIds', () => {
  it('keeps only distinct account-id-like actors', () => {
    const audit = ['a1', 'a1', 'sample:x-y', 'canon:system', 'b2'].map((actor) => ({ actor }));
    expect(actorIds(audit)).toEqual(['a1', 'b2']);
  });
});

describe('eventLabel', () => {
  const names = { u1: 'Dana Lee' };
  it('labels SUPERSEDED with deltaItems', () => {
    expect(eventLabel(ev('SUPERSEDED', 'u1', { fromVersion: 3, toVersion: 4, deltaItems: 2 }), names)).toBe(
      'Procedure v4 approved by Dana Lee; work superseded (v3 → v4, 2 material changes)',
    );
  });
  it('labels SUPERSEDED without deltaItems', () => {
    expect(eventLabel(ev('SUPERSEDED', 'u1', { fromVersion: 3, toVersion: 4 }), names)).toBe(
      'Procedure v4 approved by Dana Lee; work superseded (v3 → v4)',
    );
  });
  it('labels BOUND, closed, reopened and default', () => {
    expect(eventLabel(ev('BOUND', 'sample:priya-nair', { version: 3 }))).toBe('Bound to v3 by Priya Nair (sample)');
    expect(eventLabel(ev('WORK_CLOSED', 'u1'))).toBe('Work closed');
    expect(eventLabel(ev('WORK_REOPENED', 'u1'))).toBe('Work reopened');
    expect(eventLabel(ev('SIGNED_OFF', 'canon:system'))).toBe('Signed off by Canon (system) (independent checker)');
  });
});
