// Admin-only resolvers for Canon setup. Logic is dependency-injected; real wiring lives in resolvers.ts.
import { loadSampleData, publishSampleV4, resetSampleData, SampleError, type SampleDeps } from '../domain/sampleData';
import { runSetupChecks, type SetupDeps } from '../domain/setupChecks';
import type { Repos } from '../domain/repos';
import type { Settings } from '../domain/types';

export type AdminDeps = {
  isAdmin(): Promise<boolean>;
  repos: Repos;
  setup: SetupDeps;
  sample: SampleDeps;
};

type Req = { context?: { accountId?: string }; payload?: unknown };
type Fail = { ok: false; error: 'NOT_ADMIN' | 'INTERNAL' | 'INVALID_INPUT' | 'NOT_LOADED'; message: string };

const KEY_RE = /^[A-Z][A-Z0-9_]{1,19}$/;
const AUTO_BIND_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,79}(\/[A-Za-z0-9][A-Za-z0-9 _.\-]{0,79})?$/;
const PAGE_ID_RE = /^[0-9]{1,20}$/;
export const AUTO_BIND_MAX = 50;

const invalid = (message: string): Fail => ({ ok: false, error: 'INVALID_INPUT', message });

async function adminOnly<T extends object>(
  deps: AdminDeps,
  run: () => Promise<T | Fail>,
): Promise<({ ok: true } & T) | Fail> {
  try {
    if (!(await deps.isAdmin().catch(() => false))) {
      return { ok: false, error: 'NOT_ADMIN', message: 'Only Jira administrators can use Canon setup.' };
    }
    const r = await run();
    if ('ok' in r && r.ok === false) return r as Fail;
    return { ok: true, ...(r as T) };
  } catch (e) {
    console.error('canon admin resolver failed', e instanceof Error ? e.message : String(e));
    return { ok: false, error: 'INTERNAL', message: 'Something went wrong. Try again.' };
  }
}

export const setupChecksHandler = (_req: unknown, deps: AdminDeps) =>
  adminOnly(deps, async () => runSetupChecks(deps.setup));

export const sampleStateHandler = (_req: unknown, deps: AdminDeps) =>
  adminOnly(deps, async () => ({ sample: await deps.repos.sample.get() }));

export const loadSampleHandler = (req: unknown, deps: AdminDeps) =>
  adminOnly(deps, async () => {
    const r = req as Req;
    const p = (r.payload ?? {}) as { spaceKey?: unknown; projectKey?: unknown };
    if (typeof p.spaceKey !== 'string' || !KEY_RE.test(p.spaceKey)) return invalid('Space key is not valid.');
    if (typeof p.projectKey !== 'string' || !KEY_RE.test(p.projectKey)) return invalid('Project key is not valid.');
    const actor = r.context?.accountId;
    if (!actor) return invalid('Missing user context.');
    const result = await loadSampleData(deps.sample, { spaceKey: p.spaceKey, projectKey: p.projectKey, actor });
    return { result };
  });

export const publishV4Handler = (req: unknown, deps: AdminDeps) =>
  adminOnly(deps, async () => {
    const actor = (req as Req).context?.accountId;
    if (!actor) return invalid('Missing user context.');
    return { result: await publishSampleV4(deps.sample, { actor }) };
  });

export const resetSampleHandler = (req: unknown, deps: AdminDeps) =>
  adminOnly(deps, async () => {
    const actor = (req as Req).context?.accountId;
    if (!actor) return invalid('Missing user context.');
    try {
      return { result: await resetSampleData(deps.sample, { actor }) };
    } catch (e) {
      if (e instanceof SampleError) return { ok: false, error: e.code, message: e.message } as Fail;
      throw e;
    }
  });

export const settingsHandler = (_req: unknown, deps: AdminDeps) =>
  adminOnly(deps, async () => ({ settings: await deps.repos.settings.get() }));

export const saveSettingsHandler = (req: unknown, deps: AdminDeps) =>
  adminOnly(deps, async () => {
    const p = ((req as Req).payload ?? {}) as Record<string, unknown>;
    if (p.validatorMode !== 'block' && p.validatorMode !== 'warn') return invalid('validatorMode must be block or warn.');
    if (p.revisionPolicy !== 'approved-only' && p.revisionPolicy !== 'every-major') {
      return invalid('revisionPolicy must be approved-only or every-major.');
    }
    const ab = p.autoBind;
    if (typeof ab !== 'object' || ab === null || Array.isArray(ab)) return invalid('autoBind must be an object.');
    const entries = Object.entries(ab as Record<string, unknown>);
    if (entries.length > AUTO_BIND_MAX) return invalid(`autoBind allows at most ${AUTO_BIND_MAX} mappings.`);
    const autoBind: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (!AUTO_BIND_KEY_RE.test(k)) return invalid(`Invalid auto-bind key "${k.slice(0, 40)}".`);
      if (typeof v !== 'string' || !PAGE_ID_RE.test(v)) return invalid('Auto-bind values must be numeric page ids.');
      autoBind[k] = v;
    }
    const current = await deps.repos.settings.get();
    const next: Settings = {
      ...current,
      validatorMode: p.validatorMode,
      revisionPolicy: p.revisionPolicy,
      autoBind,
    };
    await deps.repos.settings.put(next);
    return { settings: next };
  });
