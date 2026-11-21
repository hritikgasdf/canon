import { evaluateGate, FAIL_CLOSED_MESSAGE, type Binding } from './gate';

export type GateState = 'NO_BINDING' | 'CURRENT' | 'SUPERSEDED' | 'UNVERIFIED';

export type GateStatusOk = {
  ok: true;
  issueKey: string;
  bound: boolean;
  pageId?: string;
  title?: string;
  boundVersion?: number;
  currentVersion?: number;
  state: GateState;
  message: string;
};

export type GateStatusInput = {
  issueKey: string;
  /** Parsed binding, or null when the work item has no canon-binding property. */
  binding: Binding | null;
  /** Live Confluence version, or null when it could not be read. */
  currentVersion: number | null;
  /** Set when any lookup failed; forces UNVERIFIED. */
  error?: string;
};

const UNVERIFIED_MESSAGE =
  'Canon could not verify the procedure version right now. Try again later; nothing was changed.';

/** Pure mapping from lookup results to the Rovo-facing gate status. Never throws. */
export function toGateStatus(input: GateStatusInput): GateStatusOk {
  const { issueKey, binding, currentVersion, error } = input;

  if (binding === null && error === undefined) {
    return {
      ok: true,
      issueKey,
      bound: false,
      state: 'NO_BINDING',
      message: 'This work item is not bound to a Confluence procedure.',
    };
  }

  const bindingFields =
    binding === null
      ? {}
      : {
          pageId: binding.pageId,
          boundVersion: binding.boundVersion,
          ...(binding.title !== undefined ? { title: binding.title } : {}),
        };
  const bound = binding !== null;
  const name = binding === null ? '' : (binding.title ?? `page ${binding.pageId}`);

  if (error !== undefined || binding === null) {
    return {
      ok: true,
      issueKey,
      bound,
      ...bindingFields,
      state: 'UNVERIFIED',
      message: error !== undefined ? error : UNVERIFIED_MESSAGE,
    };
  }

  const evaluated = evaluateGate({ issueKey, binding, currentVersion });
  if (evaluated.errorMessage === FAIL_CLOSED_MESSAGE) {
    return {
      ok: true,
      issueKey,
      bound,
      ...bindingFields,
      state: 'UNVERIFIED',
      message: UNVERIFIED_MESSAGE,
    };
  }
  if (evaluated.result) {
    return {
      ok: true,
      issueKey,
      bound,
      ...bindingFields,
      currentVersion: currentVersion ?? undefined,
      state: 'CURRENT',
      message: `Bound to "${name}" v${binding.boundVersion}, which is still the current version.`,
    };
  }
  return {
    ok: true,
    issueKey,
    bound,
    ...bindingFields,
    currentVersion: currentVersion ?? undefined,
    state: 'SUPERSEDED',
    message: evaluated.errorMessage ?? `Procedure "${name}" has a newer version than v${binding.boundVersion}.`,
  };
}
