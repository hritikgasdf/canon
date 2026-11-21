import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeForCompare, parseProcedure, snapshotFromXhtml } from '../src/domain/parse';
import type { StepNode } from '../src/domain/types';

const seed = (v: number): string => readFileSync(`seed/sop-pay-014/v${v}.xhtml`, 'utf8');
const fx = (n: string): string => readFileSync(`test/fixtures/${n}.xhtml`, 'utf8');
const sec = (nodes: StepNode[], title: string): StepNode => {
  const s = nodes.find((n) => n.kind === 'section' && n.text === title);
  if (!s) throw new Error(`no section ${title}`);
  return s;
};
const count = (s: StepNode, kind: StepNode['kind']): number => (s.children ?? []).filter((c) => c.kind === kind).length;

describe('seed golden', () => {
  it('v3', () => {
    const n = parseProcedure(seed(3));
    expect(n.map((s) => s.text)).toEqual([
      'Purpose & scope', 'Roles', 'Pre-checks', 'Switchover', 'Rollback', 'Post-implementation review',
    ]);
    expect(count(sec(n, 'Pre-checks'), 'step')).toBe(4);
    expect(count(sec(n, 'Rollback'), 'paragraph')).toBe(1);
    expect(count(sec(n, 'Roles'), 'step')).toBe(2);
    expect(sec(n, 'Roles').children?.[0]).toEqual({
      id: 'step:Roles:0', path: ['Roles'], kind: 'step', text: 'Change implementer: Payments SRE on call',
    });
  });
  it('v4', () => {
    const n = parseProcedure(seed(4));
    expect(count(sec(n, 'Pre-checks'), 'step')).toBe(5);
    expect(count(sec(n, 'Roles'), 'step')).toBe(3);
  });
  it('ids stable across v3/v4 for unchanged sections', () => {
    const a = parseProcedure(seed(3));
    const b = parseProcedure(seed(4));
    for (const t of ['Purpose & scope', 'Post-implementation review']) {
      expect(sec(a, t)).toEqual(sec(b, t));
    }
    const ids = (s: StepNode): string[] => (s.children ?? []).map((c) => c.id);
    expect(ids(sec(b, 'Pre-checks')).slice(0, 4)).toEqual(ids(sec(a, 'Pre-checks')));
    expect(sec(a, 'Switchover').id).toBe(sec(b, 'Switchover').id);
  });
  it('idempotent', () => {
    expect(parseProcedure(seed(3))).toEqual(parseProcedure(seed(3)));
    expect(parseProcedure(fx('macros'))).toEqual(parseProcedure(fx('macros')));
  });
});

describe('messy fixtures', () => {
  it('macros: info/expand parsed, toc/jira/code dropped', () => {
    const n = parseProcedure(fx('macros'));
    expect(n[0]).toMatchObject({ kind: 'section', text: '', path: [], id: 'section::0' });
    expect(n[0]?.children?.map((c) => c.text)).toEqual(['Intro paragraph.']);
    const o = sec(n, 'Overview');
    expect(o.children?.map((c) => [c.kind, c.text])).toEqual([
      ['paragraph', 'Read this & relax.'],
      ['step', 'Expanded step'],
    ]);
    expect(JSON.stringify(n)).not.toMatch(/Hidden title|CHG-1|rm -rf|maxLevel/);
  });
  it('table, nested lists, mentions', () => {
    const nodes = parseProcedure(fx('table-nested'));
    const c = sec(nodes, 'Ops').children ?? [];
    expect(c.filter((x) => x.kind === 'row').map((r) => r.text)).toEqual([
      'Implementer | @user:abc123',
      'Approver | @user on call',
    ]);
    const steps = c.filter((x) => x.kind === 'step');
    expect(steps.map((s) => s.text)).toEqual(['Top one', 'Top two']);
    expect(steps[0]?.children?.map((s) => s.text)).toEqual(['Child a', 'Child b']);
    expect(steps[0]?.children?.[1]?.children?.[0]).toMatchObject({ text: 'Grandchild', id: 'step:Ops:0.1.0' });
    const all: string[] = [];
    const walk = (x: StepNode): void => {
      all.push(x.id);
      x.children?.forEach(walk);
    };
    nodes.forEach(walk);
    expect(new Set(all).size).toBe(all.length);
  });
  it('heading nesting and preamble', () => {
    const n = parseProcedure(fx('headings'));
    expect(n.map((s) => s.text)).toEqual(['', 'Orphan h2', 'Main', 'Next']);
    expect(n[0]?.children?.[0]?.text).toBe('Preamble text');
    const main = sec(n, 'Main');
    expect(main.children?.filter((x) => x.kind === 'section').map((x) => x.text)).toEqual(['Sub A', 'Sub B']);
    const subA = main.children?.find((x) => x.text === 'Sub A');
    expect(subA?.children?.[0]).toMatchObject({ kind: 'section', text: 'Deep', path: ['Main', 'Sub A', 'Deep'] });
    expect(subA?.children?.[0]?.children?.[0]).toMatchObject({ id: 'paragraph:Main/Sub A/Deep:0' });
    expect(sec(n, 'Next').children?.[0]).toMatchObject({ text: 'Skip level', path: ['Next', 'Skip level'] });
  });
});

describe('helpers', () => {
  it('normalizeForCompare', () => {
    expect(normalizeForCompare('  Hold for 5 MINUTES, at 95%!  (23:30) ')).toBe('hold for 5 minutes at 95% 23:30');
  });
  it('snapshotFromXhtml hashes body', () => {
    const s = snapshotFromXhtml('1', 3, seed(3));
    expect(s.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.bodyHash).not.toBe(snapshotFromXhtml('1', 4, seed(4)).bodyHash);
    expect(s.nodes).toEqual(parseProcedure(seed(3)));
  });
});
