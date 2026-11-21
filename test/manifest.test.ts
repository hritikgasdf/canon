import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Mod = Record<string, unknown>;
const manifest = parse(readFileSync('manifest.yml', 'utf8')) as { modules: Record<string, Mod[]> };
const m = manifest.modules;
const actionKeys = new Set((m.action ?? []).map((a) => a.key as string));
const functionKeys = new Set((m.function ?? []).map((f) => f.key as string));

describe('manifest cross-references', () => {
  it('every action points at a declared function', () => {
    for (const a of m.action ?? []) expect(functionKeys.has(a.function as string)).toBe(true);
  });
  it('agent actions, skill tools and MCP tools reference existing actions', () => {
    const refs = [
      ...(m['rovo:agent'] ?? []).flatMap((x) => (x.actions as string[]) ?? []),
      ...(m['rovo:skill'] ?? []).flatMap((x) => ((x.dependencies as { tools?: string[] })?.tools ?? [])),
      ...(m['rovo:mcp'] ?? []).flatMap((x) => (x.tools as string[]) ?? []),
    ];
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(actionKeys.has(r)).toBe(true);
  });
  it('MCP exposes only read-only (GET) actions', () => {
    for (const t of (m['rovo:mcp'] ?? []).flatMap((x) => (x.tools as string[]) ?? [])) {
      const a = (m.action ?? []).find((x) => x.key === t);
      expect(a?.actionVerb).toBe('GET');
    }
  });
  it('function keys are at most 23 characters (forge lint rule)', () => {
    for (const k of functionKeys) expect(k.length).toBeLessThanOrEqual(23);
  });
  it('the production manifest has no webtrigger (dev harness stays out of the repo)', () => {
    expect(m.webtrigger).toBeUndefined();
  });
});
