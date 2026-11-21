// Persistence + audit around the pure attestation rules in attest.ts. No @forge/* imports.
// Every mutation re-reads state from the repos; the actor is always supplied by the caller.
import { appendAudit } from './audit';
import { assignChecker, AttestError, completeItem, markNotMaterial, sign, startAttestation } from './attest';
import type { Repos } from './repos';
import { ensureDelta, type BodyFetcher } from './supersede';
import type { Attestation, Binding } from './types';

type Ref = { issueKey: string; bindingId: string };

async function loadBinding(repos: Repos, p: Ref): Promise<Binding> {
  const b = await repos.bindings.get(p.bindingId);
  if (!b || b.issueKey !== p.issueKey) throw new AttestError('NOT_FOUND', 'No such binding on this issue.');
  return b;
}

/** The version the binding must be re-attested to, or null when nothing newer exists. */
async function targetOf(repos: Repos, b: Binding): Promise<number | null> {
  const proc = await repos.procedures.get(b.pageId);
  const target = b.supersededBy ?? proc?.currentApproved ?? null;
  return target !== null && target > b.boundVersion ? target : null;
}

export async function getAttestation(repos: Repos, p: Ref): Promise<Attestation | null> {
  const b = await loadBinding(repos, p);
  const target = await targetOf(repos, b);
  return target === null ? null : repos.attestations.get(b.id, target);
}

export async function startReattestation(
  repos: Repos,
  fetchBody: BodyFetcher,
  p: Ref & { actor: string; at: string },
): Promise<Attestation> {
  const b = await loadBinding(repos, p);
  if (b.state !== 'SUPERSEDED' && b.state !== 'REATTESTING') {
    throw new AttestError('BAD_STATE', `Binding is ${b.state}; nothing to re-attest.`);
  }
  const target = await targetOf(repos, b);
  if (target === null) throw new AttestError('NO_TARGET', 'No newer approved version to attest.');

  const existing = await repos.attestations.get(b.id, target);
  if (existing) return existing;

  const { delta } = await ensureDelta(repos, fetchBody, b.pageId, b.boundVersion, target);
  const att = startAttestation({ bindingId: b.id, delta, implementer: p.actor });
  await repos.attestations.put(att);
  await repos.bindings.put({ ...b, state: 'REATTESTING', supersededBy: target });
  await appendAudit(repos.audit, {
    issueKey: b.issueKey,
    type: 'REATTEST_STARTED',
    actor: p.actor,
    at: p.at,
    payload: { bindingId: b.id, toVersion: target, items: att.items.length },
  });
  return att;
}

/** Loads the open attestation for a binding that is REATTESTING. */
async function loadOpen(repos: Repos, p: Ref): Promise<{ b: Binding; att: Attestation }> {
  const b = await loadBinding(repos, p);
  if (b.state !== 'REATTESTING') {
    throw new AttestError('BAD_STATE', `Binding is ${b.state}; re-attestation not in progress.`);
  }
  const att = await getAttestation(repos, p);
  if (!att) throw new AttestError('NOT_STARTED', 'Re-attestation has not been started.');
  return { b, att };
}

export async function attestItem(
  repos: Repos,
  p: Ref & { itemId: string; action: 'DONE' | 'NOT_MATERIAL'; note?: string; actor: string; at: string },
): Promise<Attestation> {
  if (p.action !== 'DONE' && p.action !== 'NOT_MATERIAL') {
    throw new AttestError('INVALID_ACTION', 'action must be DONE or NOT_MATERIAL');
  }
  const note = typeof p.note === 'string' ? p.note.trim() : '';
  if (p.action === 'NOT_MATERIAL' && note === '') {
    throw new AttestError('NOTE_REQUIRED', 'A reason is required to mark an item not material.');
  }
  const { b, att } = await loadOpen(repos, p);
  const next =
    p.action === 'DONE'
      ? completeItem(att, { itemId: p.itemId, actor: p.actor, at: p.at, note: note === '' ? 'Done' : note })
      : markNotMaterial(att, { itemId: p.itemId, actor: p.actor, at: p.at, reason: note });
  await repos.attestations.put(next);
  await appendAudit(repos.audit, {
    issueKey: b.issueKey,
    type: 'ITEM_ATTESTED',
    actor: p.actor,
    at: p.at,
    payload: {
      itemId: p.itemId,
      action: p.action,
      note: next.items.find((i) => i.itemId === p.itemId)?.note ?? null,
    },
  });
  return next;
}

export async function signOff(repos: Repos, p: Ref & { actor: string; at: string }): Promise<Attestation> {
  const { b, att } = await loadOpen(repos, p);
  const independent = (await repos.settings.get()).requireIndependentApprover;
  if (independent && (p.actor === att.implementer || att.items.some((i) => i.by === p.actor))) {
    throw new AttestError(
      'SELF_SIGN',
      'The signer must be independent of the implementer and of everyone who attested an item.',
    );
  }
  if (att.items.some((i) => i.status === 'PENDING')) {
    throw new AttestError('ITEMS_OPEN', 'All items must be done or not material');
  }
  // attest.sign wants a checker; the signer becomes the checker unless one is already assigned.
  const withChecker =
    att.checker !== undefined
      ? att
      : p.actor === att.implementer
        ? { ...att, checker: p.actor }
        : assignChecker(att, { checker: p.actor });
  const sealed = sign(withChecker, { actor: p.actor, at: p.at, allowImplementer: !independent });
  await repos.attestations.put(sealed);
  await repos.bindings.put({ ...b, state: 'CLEARED', supersededBy: sealed.toVersion, clearedAt: p.at });
  await appendAudit(repos.audit, {
    issueKey: b.issueKey,
    type: 'SIGNED_OFF',
    actor: p.actor,
    at: p.at,
    payload: { bindingId: b.id, toVersion: sealed.toVersion, sealHash: sealed.sealHash },
  });
  return sealed;
}
