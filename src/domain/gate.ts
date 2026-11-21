export type Binding = { pageId: string; boundVersion: number; title?: string; forceError?: boolean };

export const FAIL_CLOSED_MESSAGE =
  'Canon could not verify the procedure version, so this transition is blocked. Try again; nothing was changed.';

export type GateResult = { result: boolean; errorMessage?: string };

const isPositiveInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

export function parseBinding(value: unknown): Binding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('binding must be an object');
  }
  const v = value as Record<string, unknown>;
  if (typeof v.pageId !== 'string' || !/^\d+$/.test(v.pageId)) {
    throw new Error('binding.pageId must be a non-empty digits string');
  }
  if (!isPositiveInt(v.boundVersion)) {
    throw new Error('binding.boundVersion must be a positive integer');
  }
  const binding: Binding = { pageId: v.pageId, boundVersion: v.boundVersion };
  if (typeof v.title === 'string') binding.title = v.title;
  if (v.forceError === true) binding.forceError = true;
  return binding;
}

export function evaluateGate(input: {
  issueKey: string;
  binding: Binding | null;
  currentVersion: number | null;
}): GateResult {
  const { issueKey, binding, currentVersion } = input;
  if (binding === null) return { result: true };
  if (!isPositiveInt(currentVersion)) return { result: false, errorMessage: FAIL_CLOSED_MESSAGE };
  if (currentVersion > binding.boundVersion) {
    const name = binding.title ?? `page ${binding.pageId}`;
    return {
      result: false,
      errorMessage: `Canon: procedure "${name}" was revised v${binding.boundVersion} → v${currentVersion} while ${issueKey} was open. Re-attest the changes in the Canon panel before closing.`,
    };
  }
  return { result: true };
}
