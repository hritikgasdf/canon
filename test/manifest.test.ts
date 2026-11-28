import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('security posture (docs/security.md)', () => {
  const full = parse(readFileSync('manifest.yml', 'utf8')) as {
    permissions?: { scopes?: string[]; external?: unknown };
    remotes?: unknown;
  };
  const doc = readFileSync('docs/security.md', 'utf8');

  it('declares no egress and no remotes', () => {
    expect(full.permissions?.external).toBeUndefined();
    expect(full.remotes).toBeUndefined();
  });
  it('requests exactly the documented least-privilege scopes, each explained in docs/security.md', () => {
    const scopes = [...(full.permissions?.scopes ?? [])].sort();
    expect(scopes).toEqual(
      [
        'read:confluence-content.summary',
        'read:jira-user',
        'read:jira-work',
        'read:page:confluence',
        'read:space:confluence',
        'storage:app',
        'write:jira-work',
        'write:page:confluence',
      ].sort(),
    );
    for (const sc of scopes) expect(doc).toContain(`\`${sc}\``);
  });
  it('write actions are CREATE/UPDATE (Rovo confirm card); no action can attest, sign, approve or override', () => {
    const actions = m.action ?? [];
    for (const a of actions) {
      if (a.key === 'canon-create-reattest-checklist') expect(a.actionVerb).toBe('CREATE');
      if (a.key === 'canon-assign-checker') expect(a.actionVerb).toBe('UPDATE');
      expect(String(a.key)).not.toMatch(/(^|-)(attest|sign|approve|override|done)(-|$)/);
    }
    const writes = actions.filter((a) => a.actionVerb !== 'GET').map((a) => a.key);
    expect(writes.sort()).toEqual(['canon-assign-checker', 'canon-create-reattest-checklist']);
  });
  it('source makes no direct network calls (no fetch, no XHR, no absolute URLs outside comments)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    // Works in a git checkout and in `git archive` output. The gitignored dev harness is never shipped.
    const files = walk('src').filter((f) => /\.tsx?$/.test(f) && !/devHarness/.test(f));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|https?:\/\//);
    }
  });
});
