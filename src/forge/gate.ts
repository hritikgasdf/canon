import api, { route } from '@forge/api';
import { evaluateGate, FAIL_CLOSED_MESSAGE, parseBinding, type GateResult } from '../domain/gate';

export type GateDeps = {
  getBinding(issueKey: string): Promise<unknown | null>;
  getPageVersion(pageId: string): Promise<number>;
  now(): number;
  log(line: string): void;
  timeoutMs?: number;
};

type Reason = 'no-binding' | 'current' | 'superseded' | 'error';

function extractIssueKey(args: unknown): string | null {
  const issue = (args as { issue?: { key?: unknown } } | null | undefined)?.issue;
  return typeof issue?.key === 'string' && issue.key !== '' ? issue.key : null;
}

export async function runGate(args: unknown, deps: GateDeps): Promise<GateResult> {
  const start = deps.now();
  const timeoutMs = deps.timeoutMs ?? 5000;
  let issueKey = '';
  let versionMs = 0;
  let boundVersion: number | undefined;
  let currentVersion: number | undefined;
  let outcome: GateResult;
  let reason: Reason;
  let error: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const check = async (): Promise<{ outcome: GateResult; reason: Reason }> => {
      const key = extractIssueKey(args);
      if (key === null) throw new Error('missing issue key');
      issueKey = key;
      const raw = await deps.getBinding(key);
      if (raw === null || raw === undefined) return { outcome: { result: true }, reason: 'no-binding' };
      const binding = parseBinding(raw);
      boundVersion = binding.boundVersion;
      if (binding.forceError) throw new Error('forceError set on binding');
      const vStart = deps.now();
      try {
        currentVersion = await deps.getPageVersion(binding.pageId);
      } finally {
        versionMs = deps.now() - vStart;
      }
      const evaluated = evaluateGate({ issueKey: key, binding, currentVersion });
      if (evaluated.errorMessage === FAIL_CLOSED_MESSAGE) throw new Error('invalid current version');
      return { outcome: evaluated, reason: evaluated.result ? 'current' : 'superseded' };
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    });
    const r = await Promise.race([check(), timeout]);
    outcome = r.outcome;
    reason = r.reason;
  } catch (e) {
    outcome = { result: false, errorMessage: FAIL_CLOSED_MESSAGE };
    reason = 'error';
    error = e instanceof Error ? e.message : String(e);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  try {
    deps.log(
      JSON.stringify({
        tag: 'canon-gate',
        issueKey,
        result: outcome.result,
        reason,
        totalMs: deps.now() - start,
        versionMs,
        boundVersion,
        currentVersion,
        error,
      }),
    );
  } catch {
    // logging must never change the gate outcome
  }
  return outcome;
}

export async function canonGate(args: unknown): Promise<GateResult> {
  return runGate(args, {
    async getBinding(issueKey) {
      const res = await api
        .asApp()
        .requestJira(route`/rest/api/3/issue/${issueKey}/properties/canon-binding`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`binding lookup failed: ${res.status}`);
      const json = (await res.json()) as { value?: unknown };
      return json.value ?? null;
    },
    async getPageVersion(pageId) {
      const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${pageId}`);
      if (!res.ok) throw new Error(`page lookup failed: ${res.status}`);
      const json = (await res.json()) as { version?: { number?: number } };
      return json.version?.number as number;
    },
    now: () => Date.now(),
    log: (line) => console.log(line),
  });
}
