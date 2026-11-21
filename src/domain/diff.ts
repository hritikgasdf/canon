import { normalizeForCompare } from './parse';
import type { Delta, DeltaHint, DeltaItem, DeltaKind, StepNode } from './types';

export const ENGINE_VERSION = 'canon-diff-1';

export interface DiffInput {
  pageId: string;
  fromVersion: number;
  toVersion: number;
  from: StepNode[];
  to: StepNode[];
  fromHash: string;
  toHash: string;
}

interface Leaf {
  kind: StepNode['kind'];
  path: string[];
  text: string;
  norm: string;
}

interface Sec {
  order: number;
  path: string[];
  key: string;
  title: string;
  leaves: Leaf[];
}

interface Gap {
  toOrder: number; // sort bucket
  startPos: number; // sort position
  from: Leaf[];
  to: Leaf[];
  fromPos: number[];
  toPos: number[];
}

interface Raw {
  kind: DeltaKind;
  path: string[];
  before: Leaf | null;
  after: Leaf | null;
  order: number;
  pos: number;
}

const NUM = /\d+(?:[.,]\d+)?/g;
const MENTION = /@[\w:.-]+/g;
const DURATION = /\b\d+\s*(?:seconds?|minutes?|mins?|hours?|hrs?|days?)\b/gi;
const MODAL = /\b(?:must|shall|never|prohibited|not permitted|required|mandatory)\b/gi;
const ROLE = /approver|implementer|officer|owner|manager|head of|duty|dual control|four-eyes|co-approve/i;
const APPROVER = /approv/i;

function leavesOf(nodes: StepNode[], out: Leaf[] = []): Leaf[] {
  for (const n of nodes) {
    if (n.kind !== 'section') out.push({ kind: n.kind, path: n.path, text: n.text, norm: normalizeForCompare(n.text) });
    if (n.kind !== 'section' && n.children) leavesOf(n.children, out);
  }
  return out;
}

function sections(nodes: StepNode[], out: Sec[] = []): Sec[] {
  for (const n of nodes) {
    if (n.kind !== 'section') continue;
    const direct = (n.children ?? []).filter((c) => c.kind !== 'section');
    out.push({
      order: out.length,
      path: n.path,
      key: n.path.map(normalizeForCompare).join('/'),
      title: normalizeForCompare(n.text),
      leaves: leavesOf(direct),
    });
    sections(n.children ?? [], out);
  }
  return out;
}

const tokens = (s: string): string[] => (s ? s.split(' ') : []);

function jaccard(a: string, b: string): number {
  const x = new Set(tokens(a));
  const y = new Set(tokens(b));
  if (x.size === 0 && y.size === 0) return 1;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

function levenshtein(a: string, b: string): number {
  const m = b.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[m] ?? 0;
}

function charSim(a: string, b: string): number {
  const len = Math.max(a.length, b.length);
  return len === 0 ? 1 : 1 - levenshtein(a, b) / len;
}

const similarity = (a: string, b: string): number => Math.max(jaccard(a, b), charSim(a, b));

/** LCS alignment on normalized text; returns index pairs in order. */
function lcs(a: Leaf[], b: Leaf[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const cell = (i: number, j: number): number => dp[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = dp[i];
      if (!row) continue;
      row[j] = a[i]?.norm === b[j]?.norm ? cell(i + 1, j + 1) + 1 : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i]?.norm === b[j]?.norm) {
      out.push([i, j]);
      i++;
      j++;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) i++;
    else j++;
  }
  return out;
}

function matchSections(from: Sec[], to: Sec[]): { pairs: Array<[Sec, Sec]>; fromOnly: Sec[]; toOnly: Sec[] } {
  const pairs: Array<[Sec, Sec]> = [];
  const usedTo = new Set<Sec>();
  const usedFrom = new Set<Sec>();
  for (const f of from) {
    const t = to.find((c) => !usedTo.has(c) && c.key === f.key);
    if (t) {
      pairs.push([f, t]);
      usedTo.add(t);
      usedFrom.add(f);
    }
  }
  const cands: Array<{ f: Sec; t: Sec; s: number }> = [];
  for (const f of from) {
    if (usedFrom.has(f)) continue;
    for (const t of to) {
      if (usedTo.has(t)) continue;
      const s = jaccard(f.title, t.title);
      if (s >= 0.6) cands.push({ f, t, s });
    }
  }
  cands.sort((x, y) => y.s - x.s || x.f.order - y.f.order || x.t.order - y.t.order);
  for (const c of cands) {
    if (usedFrom.has(c.f) || usedTo.has(c.t)) continue;
    usedFrom.add(c.f);
    usedTo.add(c.t);
    pairs.push([c.f, c.t]);
  }
  return {
    pairs,
    fromOnly: from.filter((s) => !usedFrom.has(s)),
    toOnly: to.filter((s) => !usedTo.has(s)),
  };
}

const REMOVED_BASE = 1_000_000;

function gapsFor(f: Sec, t: Sec): Gap[] {
  const anchors = lcs(f.leaves, t.leaves);
  const gaps: Gap[] = [];
  let pf = 0;
  let pt = 0;
  for (const [i, j] of [...anchors, [f.leaves.length, t.leaves.length] as [number, number]]) {
    if (i > pf || j > pt) {
      gaps.push({
        toOrder: t.order,
        startPos: pt,
        from: f.leaves.slice(pf, i),
        to: t.leaves.slice(pt, j),
        fromPos: f.leaves.slice(pf, i).map((_, k) => pf + k),
        toPos: t.leaves.slice(pt, j).map((_, k) => pt + k),
      });
    }
    pf = i + 1;
    pt = j + 1;
  }
  return gaps;
}

const numSet = (s: string): string => [...new Set(s.match(NUM) ?? [])].sort().join('|');
const mentionSet = (s: string): string => [...new Set(s.match(MENTION) ?? [])].sort().join('|');

function isTrivial(a: string, b: string): boolean {
  if (numSet(a) !== numSet(b) || mentionSet(a) !== mentionSet(b)) return false;
  const squash = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (squash(a) === squash(b)) return true;
  const wa = a.trim().split(/\s+/);
  const wb = b.trim().split(/\s+/);
  if (wa.length !== wb.length) return false;
  const core = (w: string): string => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const diffs: Array<[string, string]> = [];
  wa.forEach((w, i) => {
    const o = wb[i] ?? '';
    if (w !== o) diffs.push([core(w), core(o)]);
  });
  if (diffs.length !== 1) return false;
  const [x, y] = diffs[0] ?? ['', ''];
  return /^\p{L}+$/u.test(x) && /^\p{L}+$/u.test(y) && levenshtein(x, y) <= 2;
}

const lower = (re: RegExp, s: string): string => [...new Set((s.match(re) ?? []).map((m) => m.toLowerCase().replace(/\s+/g, ' ')))].sort().join('|');

function hintsFor(kind: DeltaKind, leaf: Leaf | null, before: string | null, after: string | null): DeltaHint[] {
  if ((kind !== 'ADDED' && kind !== 'CHANGED') || after === null) return [];
  const h: DeltaHint[] = [];
  const added = kind === 'ADDED';
  const b = before ?? '';
  if (added ? NUM_TEST(after) : numSet(after) !== numSet(b)) h.push('NUMBER');
  if (lower(DURATION, after) && lower(DURATION, after) !== (added ? '' : lower(DURATION, b))) h.push('DURATION');
  if (ROLE.test(after)) h.push('ROLE');
  if (APPROVER.test(after)) h.push('APPROVER');
  if (mentionSet(after) && mentionSet(after) !== (added ? '' : mentionSet(b))) h.push('MENTION');
  if (lower(MODAL, after) && lower(MODAL, after) !== (added ? '' : lower(MODAL, b))) h.push('MODAL');
  if (added && leaf?.kind === 'step') h.push('NEW_STEP');
  return h;
}

const NUM_TEST = (s: string): boolean => numSet(s) !== '';

export function diffProcedures(input: DiffInput): Delta {
  const from = sections(input.from);
  const to = sections(input.to);
  const { pairs, fromOnly, toOnly } = matchSections(from, to);

  const gaps: Gap[] = [];
  const raws: Raw[] = [];
  for (const [f, t] of pairs) {
    gaps.push(...gapsFor(f, t));
    // Aligned on normalized text but raw text differs (case/whitespace/punctuation): CHANGED, classified later.
    for (const [i, j] of lcs(f.leaves, t.leaves)) {
      const fl = f.leaves[i];
      const tl = t.leaves[j];
      if (fl && tl && fl.text !== tl.text) raws.push({ kind: 'CHANGED', path: tl.path, before: fl, after: tl, order: t.order, pos: j });
    }
  }
  for (const f of fromOnly) {
    gaps.push({ toOrder: REMOVED_BASE + f.order, startPos: 0, from: f.leaves, to: [], fromPos: f.leaves.map((_, i) => i), toPos: [] });
  }
  for (const t of toOnly) {
    gaps.push({ toOrder: t.order, startPos: 0, from: [], to: t.leaves, fromPos: [], toPos: t.leaves.map((_, i) => i) });
  }

  // Track leftover (unresolved) entries per gap by index.
  const remFrom = gaps.map((g) => g.from.map(() => true));
  const remTo = gaps.map((g) => g.to.map(() => true));

  // MOVED: exact normalized text appears unaligned on the other side.
  const addedPool: Array<{ g: number; k: number }> = [];
  gaps.forEach((g, gi) => g.to.forEach((_, k) => addedPool.push({ g: gi, k })));
  gaps.forEach((g, gi) =>
    g.from.forEach((fl, fk) => {
      if (!fl.norm) return;
      const idx = addedPool.findIndex((a) => remTo[a.g]?.[a.k] && gaps[a.g]?.to[a.k]?.norm === fl.norm);
      const hit = idx >= 0 ? addedPool[idx] : undefined;
      const tl = hit ? gaps[hit.g]?.to[hit.k] : undefined;
      if (!hit || !tl) return;
      const rf = remFrom[gi];
      const rt = remTo[hit.g];
      if (rf) rf[fk] = false;
      if (rt) rt[hit.k] = false;
      raws.push({ kind: 'MOVED', path: tl.path, before: fl, after: tl, order: gaps[hit.g]?.toOrder ?? 0, pos: gaps[hit.g]?.toPos[hit.k] ?? 0 });
    }),
  );

  gaps.forEach((g, gi) => {
    const rf = remFrom[gi] ?? [];
    const rt = remTo[gi] ?? [];
    const cands: Array<{ fk: number; tk: number; s: number }> = [];
    g.from.forEach((fl, fk) => {
      if (!rf[fk]) return;
      g.to.forEach((tl, tk) => {
        if (!rt[tk]) return;
        const s = similarity(fl.norm, tl.norm);
        if (s >= 0.5) cands.push({ fk, tk, s });
      });
    });
    cands.sort((x, y) => y.s - x.s || x.tk - y.tk || x.fk - y.fk);
    for (const c of cands) {
      if (!rf[c.fk] || !rt[c.tk]) continue;
      rf[c.fk] = false;
      rt[c.tk] = false;
      const fl = g.from[c.fk];
      const tl = g.to[c.tk];
      if (fl && tl) raws.push({ kind: 'CHANGED', path: tl.path, before: fl, after: tl, order: g.toOrder, pos: g.toPos[c.tk] ?? 0 });
    }
    g.from.forEach((fl, fk) => {
      if (rf[fk]) raws.push({ kind: 'REMOVED', path: fl.path, before: fl, after: null, order: g.toOrder, pos: g.toOrder >= REMOVED_BASE ? (g.fromPos[fk] ?? 0) : g.startPos - 0.5 });
    });
    g.to.forEach((tl, tk) => {
      if (rt[tk]) raws.push({ kind: 'ADDED', path: tl.path, before: null, after: tl, order: g.toOrder, pos: g.toPos[tk] ?? 0 });
    });
  });

  const kindRank: Record<DeltaKind, number> = { REMOVED: 0, CHANGED: 1, MOVED: 1, ADDED: 1 };
  raws.sort((x, y) => x.order - y.order || x.pos - y.pos || kindRank[x.kind] - kindRank[y.kind]);

  const items: DeltaItem[] = raws.map((r, n) => {
    const before = r.before?.text ?? null;
    const after = r.after?.text ?? null;
    const trivial = r.kind === 'CHANGED' && before !== null && after !== null && isTrivial(before, after);
    return {
      itemId: `${r.kind}:${r.path.join('/')}:${n}`,
      path: r.path,
      kind: r.kind,
      before,
      after,
      trivial,
      hints: trivial ? [] : hintsFor(r.kind, r.after, before, after),
    };
  });

  return {
    pageId: input.pageId,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    items,
    fromHash: input.fromHash,
    toHash: input.toHash,
    engineVersion: ENGINE_VERSION,
  };
}
