import { createHash } from 'node:crypto';
import { canonicalJson } from './audit';
import type { Attestation, AttestationItem, Delta } from './types';

export type AttestErrorCode =
  | 'UNKNOWN_ITEM'
  | 'INVALID_TASK'
  | 'SEALED'
  | 'NOT_IMPLEMENTER'
  | 'NOTE_REQUIRED'
  | 'ITEM_NOT_PENDING'
  | 'SELF_REVIEW'
  | 'REASON_REQUIRED'
  | 'NOT_CHECKER'
  | 'NO_CHECKER'
  | 'ITEMS_OPEN';

export class AttestError extends Error {
  readonly code: AttestErrorCode;
  constructor(code: AttestErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'AttestError';
    this.code = code;
  }
}

export function isSealed(a: Attestation): boolean {
  return a.sealHash !== undefined;
}

function assertOpen(a: Attestation): void {
  if (isSealed(a)) throw new AttestError('SEALED', 'Attestation is sealed and cannot be changed');
}

function computeSeal(a: Attestation): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        bindingId: a.bindingId,
        toVersion: a.toVersion,
        items: a.items,
        implementer: a.implementer,
        checker: a.checker,
        checkerSignedAt: a.checkerSignedAt,
      }),
    )
    .digest('hex');
}

export function verifySeal(a: Attestation): boolean {
  return a.sealHash !== undefined && a.sealHash === computeSeal(a);
}

export function openCount(a: Attestation): number {
  return a.items.filter((i) => i.status === 'PENDING').length;
}

export function startAttestation(input: {
  bindingId: string;
  delta: Delta;
  implementer: string;
}): Attestation {
  return {
    bindingId: input.bindingId,
    toVersion: input.delta.toVersion,
    items: input.delta.items
      .filter((d) => !d.trivial)
      .map((d): AttestationItem => ({ itemId: d.itemId, status: 'PENDING' })),
    implementer: input.implementer,
  };
}

function findIndex(a: Attestation, itemId: string): number {
  const idx = a.items.findIndex((i) => i.itemId === itemId);
  if (idx < 0) throw new AttestError('UNKNOWN_ITEM', `Unknown item ${itemId}`);
  return idx;
}

function replaceItem(a: Attestation, idx: number, item: AttestationItem): Attestation {
  return { ...a, items: a.items.map((it, i) => (i === idx ? item : it)) };
}

export function setRovoTasks(a: Attestation, tasks: { itemId: string; task: string }[]): Attestation {
  assertOpen(a);
  const byId = new Map<string, string>();
  for (const t of tasks) {
    findIndex(a, t.itemId);
    const task = typeof t.task === 'string' ? t.task.trim() : '';
    if (task.length < 1 || task.length > 500) {
      throw new AttestError('INVALID_TASK', 'Task must be 1..500 characters');
    }
    byId.set(t.itemId, task);
  }
  return {
    ...a,
    items: a.items.map((it) => (byId.has(it.itemId) ? { ...it, rovoTask: byId.get(it.itemId) } : { ...it })),
  };
}

export function completeItem(
  a: Attestation,
  p: { itemId: string; actor: string; at: string; note: string },
): Attestation {
  assertOpen(a);
  if (p.actor !== a.implementer) {
    throw new AttestError('NOT_IMPLEMENTER', 'Only the implementer can complete items');
  }
  const note = typeof p.note === 'string' ? p.note.trim() : '';
  if (note.length < 3 || note.length > 1000) {
    throw new AttestError('NOTE_REQUIRED', 'Note must be 3..1000 characters');
  }
  const idx = findIndex(a, p.itemId);
  if (a.items[idx].status !== 'PENDING') throw new AttestError('ITEM_NOT_PENDING');
  return replaceItem(a, idx, { ...a.items[idx], status: 'DONE', by: p.actor, at: p.at, note });
}

export function markNotMaterial(
  a: Attestation,
  p: { itemId: string; actor: string; at: string; reason: string },
): Attestation {
  assertOpen(a);
  if (p.actor === a.implementer) {
    throw new AttestError('SELF_REVIEW', 'Implementer cannot mark items not material');
  }
  if (a.checker !== undefined && p.actor !== a.checker) {
    throw new AttestError('NOT_CHECKER', 'Only the assigned checker can mark items not material');
  }
  const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
  if (reason.length < 10 || reason.length > 1000) {
    throw new AttestError('REASON_REQUIRED', 'Reason must be 10..1000 characters');
  }
  const idx = findIndex(a, p.itemId);
  if (a.items[idx].status !== 'PENDING') throw new AttestError('ITEM_NOT_PENDING');
  return replaceItem(a, idx, {
    ...a.items[idx],
    status: 'NOT_MATERIAL',
    by: p.actor,
    at: p.at,
    note: reason,
  });
}

export function assignChecker(a: Attestation, p: { checker: string }): Attestation {
  assertOpen(a);
  if (p.checker === a.implementer) {
    throw new AttestError('SELF_REVIEW', 'Checker must differ from implementer');
  }
  return { ...a, items: a.items.map((i) => ({ ...i })), checker: p.checker };
}

export function sign(a: Attestation, p: { actor: string; at: string }): Attestation {
  assertOpen(a);
  if (a.checker === undefined) throw new AttestError('NO_CHECKER', 'No checker assigned');
  if (p.actor === a.implementer) throw new AttestError('SELF_REVIEW', 'Implementer cannot sign');
  if (p.actor !== a.checker) throw new AttestError('NOT_CHECKER', 'Only the assigned checker can sign');
  if (a.items.some((i) => i.status === 'PENDING')) {
    throw new AttestError('ITEMS_OPEN', 'All items must be done or not material');
  }
  const signed: Attestation = { ...a, items: a.items.map((i) => ({ ...i })), checkerSignedAt: p.at };
  return { ...signed, sealHash: computeSeal(signed) };
}
