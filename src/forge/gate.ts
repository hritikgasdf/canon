import { GATE_FAIL_CLOSED, type GateDecision } from "../domain/gateEval";
import { runCanonGate } from "../domain/gateRun";
import type { GateHeartbeatRepo } from "../domain/repos";
import type { GateHeartbeat } from "../domain/types";
import { fetchBody, getPageMeta } from "./confluence";
import { createAppRepos } from "./kvsRepos";

export type GateResult = { result: boolean; errorMessage?: string };

export type GateDeps = {
  gate(issueKey: string): Promise<GateDecision & { bindingCount: number }>;
  now(): number;
  log(line: string): void;
  timeoutMs?: number;
  /** Best-effort setup heartbeat; throttled by the implementation. Never affects the outcome. */
  heartbeat?(h: GateHeartbeat): Promise<void>;
};

/** Minimum gap between gate heartbeat writes. */
export const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 300;

type Reason = "no-binding" | "allow" | "block" | "warn" | "error";

function extractIssueKey(args: unknown): string | null {
  const issue = (args as { issue?: { key?: unknown } } | null | undefined)
    ?.issue;
  return typeof issue?.key === "string" && issue.key !== "" ? issue.key : null;
}

export async function runGate(
  args: unknown,
  deps: GateDeps,
): Promise<GateResult> {
  const start = deps.now();
  const timeoutMs = deps.timeoutMs ?? 5000;
  let issueKey = "";
  let bindingCount = 0;
  let codes: string[] = [];
  let outcome: GateResult;
  let reason: Reason;
  let error: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const check = async (): Promise<{
      outcome: GateResult;
      reason: Reason;
    }> => {
      const key = extractIssueKey(args);
      if (key === null) throw new Error("missing issue key");
      issueKey = key;
      const d = await deps.gate(key);
      bindingCount = d.bindingCount;
      codes = d.reasons.map((r) => r.code);
      if (d.allow) {
        const r: Reason =
          d.bindingCount === 0 ? "no-binding" : d.warnOnly ? "warn" : "allow";
        return { outcome: { result: true }, reason: r };
      }
      return {
        outcome: { result: false, errorMessage: d.message ?? GATE_FAIL_CLOSED },
        reason: "block",
      };
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const r = await Promise.race([check(), timeout]);
    outcome = r.outcome;
    reason = r.reason;
  } catch (e) {
    outcome = { result: false, errorMessage: GATE_FAIL_CLOSED };
    reason = "error";
    error = e instanceof Error ? e.message : String(e);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  try {
    deps.log(
      JSON.stringify({
        tag: "canon-gate",
        issueKey,
        result: outcome.result,
        reason,
        totalMs: deps.now() - start,
        bindingCount,
        codes,
        error,
      }),
    );
  } catch {
    // logging must never change the gate outcome
  }
  if (deps.heartbeat) {
    // Bounded: a slow or failing heartbeat can never change or noticeably delay the outcome.
    let hbTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const beat = deps.heartbeat({
        at: new Date(deps.now()).toISOString(),
        issueKey,
        outcome: reason,
      });
      await Promise.race([
        beat,
        new Promise<void>((resolve) => {
          hbTimer = setTimeout(resolve, HEARTBEAT_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // heartbeat is best effort
    } finally {
      if (hbTimer !== undefined) clearTimeout(hbTimer);
    }
  }
  return outcome;
}

/**
 * Throttled heartbeat writer: skips when the stored heartbeat is under 10 minutes old.
 * The previous heartbeat is read once, at creation, so the read runs concurrently with the gate
 * decision instead of after it; after the decision only a cheap write (if due) remains, bounded
 * by HEARTBEAT_TIMEOUT_MS in runGate.
 */
export function createThrottledHeartbeat(
  repo: GateHeartbeatRepo,
  now: () => number,
): (h: GateHeartbeat) => Promise<void> {
  let prev: Promise<GateHeartbeat | null> = repo.get().catch(() => null);
  return async (h) => {
    const last = await prev;
    if (last !== null) {
      const age = now() - Date.parse(last.at);
      if (Number.isFinite(age) && age >= 0 && age < HEARTBEAT_INTERVAL_MS)
        return;
    }
    await repo.put(h);
    prev = Promise.resolve(h);
  };
}

export async function canonGate(args: unknown): Promise<GateResult> {
  const repos = createAppRepos();
  return runGate(args, {
    heartbeat: createThrottledHeartbeat(repos.gateHeartbeat, () => Date.now()),
    gate: (issueKey) =>
      runCanonGate(issueKey, {
        repos,
        getPageMeta,
        fetchBody,
        now: () => new Date().toISOString(),
      }),
    now: () => Date.now(),
    log: (line) => console.log(line),
  });
}
