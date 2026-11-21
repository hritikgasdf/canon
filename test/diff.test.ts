import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, diffProcedures } from '../src/domain/diff';
import { parseProcedure } from '../src/domain/parse';
import type { Delta, DeltaItem } from '../src/domain/types';

const seed = (v: number): string => readFileSync(`seed/sop-pay-014/v${v}.xhtml`, 'utf8');
const run = (a: string, b: string): Delta =>
  diffProcedures({ pageId: 'p', fromVersion: 1, toVersion: 2, from: parseProcedure(a), to: parseProcedure(b), fromHash: 'h1', toHash: 'h2' });
const seeds = (a: number, b: number): Delta => run(seed(a), seed(b));
const find = (d: Delta, kind: string, section: string): DeltaItem => {
  const it = d.items.find((i) => i.kind === kind && i.path.join('/') === section);
  if (!it) throw new Error(`no ${kind} in ${section}: ${JSON.stringify(d.items)}`);
  return it;
};
const ol = (...s: string[]): string => `<ol>${s.map((x) => `<li>${x}</li>`).join('')}</ol>`;

describe('golden v3 -> v4', () => {
  const d = seeds(3, 4);
  it('has 3 non-trivial + 1 trivial', () => {
    expect(d.engineVersion).toBe(ENGINE_VERSION);
    expect(d.items.filter((i) => !i.trivial)).toHaveLength(3);
    expect(d.items.filter((i) => i.trivial)).toHaveLength(1);
    expect(d.items).toHaveLength(4);
  });
  it('Rollback CHANGED', () => {
    expect(find(d, 'CHANGED', 'Rollback').hints).toEqual(expect.arrayContaining(['DURATION', 'MODAL', 'NUMBER']));
  });
  it('Roles ADDED', () => {
    const it = find(d, 'ADDED', 'Roles');
    expect(it.hints).toEqual(expect.arrayContaining(['ROLE', 'NUMBER', 'NEW_STEP']));
    expect(it.trivial).toBe(false);
  });
  it('Pre-checks ADDED', () => {
    expect(find(d, 'ADDED', 'Pre-checks').hints).toEqual(expect.arrayContaining(['NUMBER', 'NEW_STEP']));
  });
  it('Switchover trivial', () => {
    const it = find(d, 'CHANGED', 'Switchover');
    expect(it.trivial).toBe(true);
    expect(it.before).toContain('procesor');
    expect(it.after).toContain('processor');
  });
  it('ids unique, determinism', () => {
    expect(new Set(d.items.map((i) => i.itemId)).size).toBe(d.items.length);
    expect(seeds(3, 4)).toEqual(d);
  });
});

describe('other diffs', () => {
  it('identical -> 0 items', () => {
    expect(seeds(3, 3).items).toHaveLength(0);
  });
  it('v2 -> v3', () => {
    const d = seeds(2, 3);
    const roles = find(d, 'CHANGED', 'Roles');
    expect(roles.hints).toEqual(expect.arrayContaining(['APPROVER', 'ROLE']));
    expect(find(d, 'CHANGED', 'Rollback').trivial).toBe(false);
    const added = find(d, 'ADDED', 'Pre-checks');
    expect(added.after).toContain('Backup processor health check');
    expect(d.items).toHaveLength(3);
  });
  it('reorder -> MOVED', () => {
    const d = run(`<h1>A</h1>${ol('alpha one step', 'bravo two step', 'charlie three step')}`, `<h1>A</h1>${ol('charlie three step', 'alpha one step', 'bravo two step')}`);
    expect(d.items.map((i) => i.kind)).toEqual(['MOVED']);
    expect(d.items[0]?.trivial).toBe(false);
  });
  it('moved across sections', () => {
    const d = run(`<h1>A</h1>${ol('alpha one step')}<h1>B</h1>${ol('bravo two step')}`, `<h1>A</h1>${ol('alpha one step', 'bravo two step')}<h1>B</h1>`);
    expect(d.items.map((i) => i.kind)).toEqual(['MOVED']);
  });
  it('removed section -> REMOVED', () => {
    const d = run(`<h1>A</h1>${ol('one thing')}<h1>B</h1>${ol('second zzz', 'third yyy')}`, `<h1>A</h1>${ol('one thing')}`);
    expect(d.items.map((i) => i.kind)).toEqual(['REMOVED', 'REMOVED']);
    expect(d.items[0]?.path).toEqual(['B']);
  });
  it('new section -> ADDED', () => {
    const d = run(`<h1>A</h1>${ol('one thing')}`, `<h1>A</h1>${ol('one thing')}<h1>C</h1>${ol('fresh qqq')}`);
    expect(d.items.map((i) => i.kind)).toEqual(['ADDED']);
  });
  it('renamed section matched', () => {
    const d = run(`<h1>Rollback</h1>${ol('revert the flag now')}`, `<h1>Roll-back</h1>${ol('revert the flag now')}`);
    expect(d.items).toHaveLength(0);
    const e = run(`<h1>Rollback and recovery steps</h1>${ol('revert the flag now')}`, `<h1>Rollback and recovery step</h1>${ol('revert the flag soon')}`);
    expect(e.items.map((i) => i.kind)).toEqual(['CHANGED']);
  });
  it('number change only is not trivial', () => {
    const d = run(`<h1>A</h1><p>Complete within 30 minutes of start.</p>`, `<h1>A</h1><p>Complete within 15 minutes of start.</p>`);
    expect(d.items).toHaveLength(1);
    expect(d.items[0]?.trivial).toBe(false);
    expect(d.items[0]?.hints).toEqual(expect.arrayContaining(['NUMBER', 'DURATION']));
  });
  it('whitespace/case only is trivial', () => {
    const d = run(`<h1>A</h1><p>Complete the Rollback now.</p>`, `<h1>A</h1><p>complete  the rollback   NOW</p>`);
    expect(d.items).toHaveLength(1);
    expect(d.items[0]?.kind).toBe('CHANGED');
    expect(d.items[0]?.trivial).toBe(true);
  });
  it('mention change is not trivial', () => {
    const d = run(`<h1>A</h1><p>Ask @alice to sign off.</p>`, `<h1>A</h1><p>Ask @alic to sign off.</p>`);
    expect(d.items[0]?.trivial).toBe(false);
  });
});
