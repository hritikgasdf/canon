import { describe, expect, it } from 'vitest';
import {
  AttestError,
  assignChecker,
  completeItem,
  isSealed,
  markNotMaterial,
  openCount,
  setRovoTasks,
  sign,
  startAttestation,
  verifySeal,
} from '../src/domain/attest';
import type { Attestation, Delta } from '../src/domain/types';

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o as Record<string, unknown>).forEach(deepFreeze);
  }
  return o;
}

const mk = (itemId: string, trivial: boolean) => ({
  itemId,
  path: ['S', itemId],
  kind: 'CHANGED' as const,
  before: 'a',
  after: 'b',
  trivial,
  hints: [],
});

const delta: Delta = {
  pageId: 'p1',
  fromVersion: 3,
  toVersion: 4,
  items: [mk('i1', false), mk('i2', false), mk('i3', false), mk('t1', true)],
  fromHash: 'f',
  toHash: 't',
  engineVersion: '1',
};

const T = '2026-01-01T00:00:00Z';
const start = () => startAttestation({ bindingId: 'b1', delta, implementer: 'impl' });
const done = (a: Attestation, id: string) =>
  completeItem(a, { itemId: id, actor: 'impl', at: T, note: 'done it' });

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof AttestError) return e.code;
    throw e;
  }
  return undefined;
}

function sealed(): Attestation {
  let a = start();
  for (const id of ['i1', 'i2', 'i3']) a = done(a, id);
  a = assignChecker(a, { checker: 'chk' });
  return sign(a, { actor: 'chk', at: T });
}

describe('attestation', () => {
  it('happy path', () => {
    const a = sealed();
    expect(isSealed(a)).toBe(true);
    expect(verifySeal(a)).toBe(true);
    expect(a.toVersion).toBe(4);
    expect(openCount(a)).toBe(0);
  });
  it('excludes trivial items', () => {
    const a = start();
    expect(a.items.map((i) => i.itemId)).toEqual(['i1', 'i2', 'i3']);
    expect(openCount(a)).toBe(3);
  });
  it('empty items still need signing', () => {
    const a = startAttestation({ bindingId: 'b', delta: { ...delta, items: [mk('t', true)] }, implementer: 'impl' });
    expect(a.items).toEqual([]);
    expect(isSealed(a)).toBe(false);
    expect(isSealed(sign(assignChecker(a, { checker: 'c' }), { actor: 'c', at: T }))).toBe(true);
  });
  it('implementer cannot sign', () => {
    let a = start();
    for (const id of ['i1', 'i2', 'i3']) a = done(a, id);
    expect(code(() => sign({ ...a, checker: 'impl' }, { actor: 'impl', at: T }))).toBe('SELF_REVIEW');
  });
  it('implementer cannot be assigned checker', () => {
    expect(code(() => assignChecker(start(), { checker: 'impl' }))).toBe('SELF_REVIEW');
  });
  it('checker cannot complete items', () => {
    expect(code(() => completeItem(start(), { itemId: 'i1', actor: 'chk', at: T, note: 'nope ok' }))).toBe(
      'NOT_IMPLEMENTER',
    );
  });
  it('complete requires a note', () => {
    expect(code(() => completeItem(start(), { itemId: 'i1', actor: 'impl', at: T, note: ' a ' }))).toBe(
      'NOTE_REQUIRED',
    );
  });
  it('not-material by checker with reason OK', () => {
    const a = markNotMaterial(assignChecker(start(), { checker: 'chk' }), {
      itemId: 'i1',
      actor: 'chk',
      at: T,
      reason: 'wording only change',
    });
    expect(a.items[0]).toMatchObject({ status: 'NOT_MATERIAL', by: 'chk', note: 'wording only change' });
  });
  it('not-material by implementer rejected', () => {
    expect(code(() => markNotMaterial(start(), { itemId: 'i1', actor: 'impl', at: T, reason: 'long enough reason' }))).toBe(
      'SELF_REVIEW',
    );
  });
  it('not-material short reason rejected', () => {
    expect(code(() => markNotMaterial(start(), { itemId: 'i1', actor: 'chk', at: T, reason: 'short' }))).toBe(
      'REASON_REQUIRED',
    );
  });
  it('sign with open items rejected', () => {
    const a = assignChecker(done(start(), 'i1'), { checker: 'chk' });
    expect(code(() => sign(a, { actor: 'chk', at: T }))).toBe('ITEMS_OPEN');
  });
  it('sign by non-assigned checker rejected', () => {
    let a = start();
    for (const id of ['i1', 'i2', 'i3']) a = done(a, id);
    a = assignChecker(a, { checker: 'chk' });
    expect(code(() => sign(a, { actor: 'other', at: T }))).toBe('NOT_CHECKER');
  });
  it('sign without checker rejected', () => {
    expect(code(() => sign(start(), { actor: 'chk', at: T }))).toBe('NO_CHECKER');
  });
  it('double complete rejected', () => {
    expect(code(() => done(done(start(), 'i1'), 'i1'))).toBe('ITEM_NOT_PENDING');
  });
  it('mutations after seal rejected', () => {
    const a = sealed();
    expect(code(() => done(a, 'i1'))).toBe('SEALED');
    expect(code(() => assignChecker(a, { checker: 'x' }))).toBe('SEALED');
    expect(code(() => setRovoTasks(a, [{ itemId: 'i1', task: 't' }]))).toBe('SEALED');
    expect(code(() => markNotMaterial(a, { itemId: 'i1', actor: 'chk', at: T, reason: 'long enough reason' }))).toBe(
      'SEALED',
    );
    expect(code(() => sign(a, { actor: 'chk', at: T }))).toBe('SEALED');
  });
  it('tamper after seal fails verifySeal', () => {
    const a = sealed();
    expect(verifySeal({ ...a, items: a.items.map((i, n) => (n === 0 ? { ...i, note: 'x' } : i)) })).toBe(false);
    expect(verifySeal({ ...a, checker: 'evil' })).toBe(false);
    expect(verifySeal(start())).toBe(false);
  });
  it('rovo tasks: unknown item and invalid task rejected, valid trimmed', () => {
    expect(code(() => setRovoTasks(start(), [{ itemId: 'zzz', task: 'x' }]))).toBe('UNKNOWN_ITEM');
    expect(code(() => setRovoTasks(start(), [{ itemId: 'i1', task: '   ' }]))).toBe('INVALID_TASK');
    expect(code(() => setRovoTasks(start(), [{ itemId: 'i1', task: 'x'.repeat(501) }]))).toBe('INVALID_TASK');
    expect(setRovoTasks(start(), [{ itemId: 'i1', task: '  do it ' }]).items[0].rovoTask).toBe('do it');
  });
  it('does not mutate frozen inputs', () => {
    const d = deepFreeze(structuredClone(delta));
    let a = deepFreeze(startAttestation({ bindingId: 'b1', delta: d, implementer: 'impl' }));
    a = deepFreeze(setRovoTasks(a, deepFreeze([{ itemId: 'i1', task: 'x' }])));
    for (const id of ['i1', 'i2']) a = deepFreeze(done(a, id));
    a = deepFreeze(markNotMaterial(a, { itemId: 'i3', actor: 'chk', at: T, reason: 'not relevant here' }));
    a = deepFreeze(assignChecker(a, { checker: 'chk' }));
    const s = sign(a, { actor: 'chk', at: T });
    expect(verifySeal(s)).toBe(true);
    expect(a.sealHash).toBeUndefined();
  });
});
