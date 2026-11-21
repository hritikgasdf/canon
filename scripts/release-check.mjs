#!/usr/bin/env node
// Release gate: fails if anything dev-only would ship in the submitted build.
// Run from a clean checkout (git archive / fresh clone): `npm run release:check`.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

const problems = [];
const manifest = parse(readFileSync('manifest.yml', 'utf8'));
const modules = manifest.modules ?? {};
if (modules.webtrigger) problems.push('manifest.yml declares a webtrigger module (dev harness).');
for (const f of modules.function ?? []) {
  if (/devHarness|dev-harness/i.test(`${f.key} ${f.handler}`))
    problems.push(`manifest function ${f.key} points at the dev harness.`);
}
const index = readFileSync('src/index.ts', 'utf8');
if (/devHarness/.test(index)) problems.push('src/index.ts exports the dev harness.');
if (existsSync('src/forge/devHarness.ts'))
  problems.push('src/forge/devHarness.ts is present in this tree (use a clean checkout).');

let tracked = [];
try {
  tracked = execSync('git ls-files', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .filter(Boolean);
} catch {
  // not a git checkout (e.g. git archive output): scan the tree we were given instead
  tracked = execSync('find src -type f', { encoding: 'utf8' }).split('\n').filter(Boolean);
}
for (const file of tracked.filter((f) => f.startsWith('src/'))) {
  const text = readFileSync(file, 'utf8');
  if (/CANON_DEV_SECRET|canon-dev-harness/.test(text)) problems.push(`${file} references the dev harness.`);
}

if (problems.length > 0) {
  console.error('RELEASE CHECK FAILED');
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log('RELEASE CHECK OK: no dev-only webtrigger, harness export or harness file.');
