import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const script = join(root, 'scripts/release-check.mjs');
let dir = '';

function cleanTree(): string {
  dir = mkdtempSync(join(tmpdir(), 'canon-release-'));
  cpSync(join(root, 'manifest.yml'), join(dir, 'manifest.yml'));
  mkdirSync(join(dir, 'src/forge'), { recursive: true });
  writeFileSync(join(dir, 'src/index.ts'), readFileSync(join(root, 'src/index.ts'), 'utf8'));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  return dir;
}

function run(cwd: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('node', [script], { cwd, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    const err = e as { stderr?: string };
    return { ok: false, out: String(err.stderr ?? '') };
  }
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('release check', () => {
  it('passes on the committed manifest and entry point', () => {
    expect(run(cleanTree()).ok).toBe(true);
  });
  it('fails when the dev webtrigger overlay is present', () => {
    const d = cleanTree();
    const m = readFileSync(join(d, 'manifest.yml'), 'utf8');
    writeFileSync(
      join(d, 'manifest.yml'),
      m.replace('  trigger:\n', '  webtrigger:\n    - key: canon-dev-harness\n      function: x\n  trigger:\n'),
    );
    const r = run(d);
    expect(r.ok).toBe(false);
    expect(r.out).toContain('webtrigger');
  });
  it('fails when the harness export or file is present', () => {
    const d = cleanTree();
    appendFileSync(join(d, 'src/index.ts'), "\nexport { devHarness } from './forge/devHarness';\n");
    writeFileSync(join(d, 'src/forge/devHarness.ts'), 'export const devHarness = 1;\n');
    const r = run(d);
    expect(r.ok).toBe(false);
    expect(r.out).toContain('harness');
  });
});
