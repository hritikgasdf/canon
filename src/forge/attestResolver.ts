// Handlers for the canonAttest* resolvers. No @forge/* imports: tests pass fakes.
// The actor is ALWAYS context.accountId; any actor in the payload is ignored.
import { AttestError } from '../domain/attest';
import { attestItem, getAttestation, signOff, startReattestation } from '../domain/attestService';
import type { Repos } from '../domain/repos';
import type { BodyFetcher } from '../domain/supersede';
import type { Attestation } from '../domain/types';

export type AttestResponse =
  | { ok: true; attestation: Attestation | null }
  | { ok: false; error: string; message: string };

export interface AttestDeps {
  repos: Repos;
  canView(pageId: string): Promise<boolean>;
  fetchBody: BodyFetcher;
  now: () => string;
}

type Req = {
  context?: { accountId?: string; extension?: { issue?: { key?: string } } };
  payload?: unknown;
};

type Run = (a: {
  issueKey: string;
  bindingId: string;
  actor: string;
  at: string;
  payload: Record<string, unknown>;
}) => Promise<Attestation | null>;

async function handle(req: unknown, deps: AttestDeps, run: Run): Promise<AttestResponse> {
  try {
    const r = (req ?? {}) as Req;
    const issueKey = r.context?.extension?.issue?.key;
    const actor = r.context?.accountId;
    if (!issueKey || !actor) return { ok: false, error: 'NO_CONTEXT', message: 'Missing issue or user context.' };

    const payload = (r.payload && typeof r.payload === 'object' ? r.payload : {}) as Record<string, unknown>;
    const bindingId = payload.bindingId;
    if (typeof bindingId !== 'string' || bindingId === '') {
      return { ok: false, error: 'INVALID_INPUT', message: 'payload.bindingId must be a non-empty string.' };
    }
    const binding = await deps.repos.bindings.get(bindingId);
    if (!binding || binding.issueKey !== issueKey) {
      return { ok: false, error: 'NOT_FOUND', message: 'No such binding on this issue.' };
    }
    if (!(await deps.canView(binding.pageId))) {
      return { ok: false, error: 'NO_ACCESS', message: 'You do not have access to this page.' };
    }
    const attestation = await run({ issueKey, bindingId, actor, at: deps.now(), payload });
    return { ok: true, attestation };
  } catch (e) {
    if (e instanceof AttestError) return { ok: false, error: e.code, message: e.message };
    return { ok: false, error: 'INTERNAL', message: e instanceof Error ? e.message : 'Unexpected error' };
  }
}

export const attestationHandler = (req: unknown, d: AttestDeps): Promise<AttestResponse> =>
  handle(req, d, (a) => getAttestation(d.repos, a));

export const attestStartHandler = (req: unknown, d: AttestDeps): Promise<AttestResponse> =>
  handle(req, d, (a) => startReattestation(d.repos, d.fetchBody, a));

export const attestItemHandler = (req: unknown, d: AttestDeps): Promise<AttestResponse> =>
  handle(req, d, async (a) => {
    const { itemId, action, note } = a.payload;
    if (typeof itemId !== 'string' || itemId === '') {
      throw new AttestError('UNKNOWN_ITEM', 'payload.itemId must be a non-empty string.');
    }
    if (action !== 'DONE' && action !== 'NOT_MATERIAL') {
      throw new AttestError('INVALID_ACTION', 'action must be DONE or NOT_MATERIAL');
    }
    return attestItem(d.repos, {
      issueKey: a.issueKey,
      bindingId: a.bindingId,
      itemId,
      action,
      note: typeof note === 'string' ? note : undefined,
      actor: a.actor,
      at: a.at,
    });
  });

export const attestSignHandler = (req: unknown, d: AttestDeps): Promise<AttestResponse> =>
  handle(req, d, (a) => signOff(d.repos, a));
