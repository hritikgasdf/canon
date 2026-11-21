import { createHash } from 'node:crypto';
import { parseDocument } from 'htmlparser2';
import type { Snapshot, StepNode } from './types';

interface DNode {
  type: string;
  data?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: DNode[];
}

interface Draft {
  kind: StepNode['kind'];
  text: string;
  children: Draft[];
  level?: number;
}

const BODY_MACROS = new Set(['info', 'note', 'warning', 'tip', 'panel', 'expand']);
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'td', 'th', 'tr', 'br', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const isTag = (n: DNode): boolean => n.type === 'tag' || n.type === 'script' || n.type === 'style';
const kids = (n: DNode): DNode[] => n.children ?? [];

function norm(s: string): string {
  return s.replace(/[\s ]+/g, ' ').trim();
}

function bodyOf(macro: DNode): DNode[] | null {
  const name = macro.attribs?.['ac:name']?.toLowerCase() ?? '';
  if (!BODY_MACROS.has(name)) return null;
  return kids(macro).filter((c) => c.name === 'ac:rich-text-body');
}

function mention(user: DNode): string {
  const id = user.attribs?.['ri:account-id'];
  return id ? `@user:${id}` : '@user';
}

/** Raw (un-normalised) inline text of a node. */
function rawText(n: DNode, skipLists: boolean): string {
  if (n.type === 'text') return n.data ?? '';
  if (!isTag(n)) return '';
  const name = n.name ?? '';
  if (name === 'ac:parameter' || name === 'ac:emoticon') return '';
  if (skipLists && (name === 'ul' || name === 'ol')) return '';
  if (name === 'ri:user') return mention(n);
  if (name === 'ac:link') {
    const user = kids(n).find((c) => c.name === 'ri:user');
    if (user) return mention(user);
  }
  if (name === 'ac:structured-macro') {
    const bodies = bodyOf(n);
    if (!bodies) return '';
    return ' ' + bodies.map((b) => rawText(b, skipLists)).join(' ') + ' ';
  }
  const inner = kids(n).map((c) => rawText(c, skipLists)).join('');
  return BLOCK_TAGS.has(name) ? ` ${inner} ` : inner;
}

const textOf = (n: DNode, skipLists = false): string => norm(rawText(n, skipLists));

function descendants(n: DNode, name: string, out: DNode[] = []): DNode[] {
  for (const c of kids(n)) {
    if (c.name === name) out.push(c);
    else descendants(c, name, out);
  }
  return out;
}

function stepOf(li: DNode): Draft | null {
  const children: Draft[] = [];
  const collect = (n: DNode): void => {
    for (const c of kids(n)) {
      if (c.name === 'ul' || c.name === 'ol') children.push(...listSteps(c));
      else if (isTag(c) && c.name !== 'ac:parameter') collect(c);
    }
  };
  collect(li);
  const text = textOf(li, true);
  if (!text && children.length === 0) return null;
  return { kind: 'step', text, children };
}

function listSteps(list: DNode): Draft[] {
  const out: Draft[] = [];
  for (const li of kids(list)) {
    if (li.name !== 'li') continue;
    const s = stepOf(li);
    if (s) out.push(s);
  }
  return out;
}

function parseDrafts(xhtml: string): Draft[] {
  const doc = parseDocument(xhtml, { recognizeSelfClosing: true }) as unknown as DNode;
  const top: Draft[] = [];
  const stack: Draft[] = [];
  let root: Draft | null = null;

  const sink = (): Draft[] => {
    const cur = stack[stack.length - 1];
    if (cur) return cur.children;
    if (!root) {
      root = { kind: 'section', text: '', children: [] };
      top.unshift(root);
    }
    return root.children;
  };

  const visit = (n: DNode): void => {
    if (!isTag(n)) return;
    const name = n.name ?? '';
    if (/^h[1-3]$/.test(name)) {
      const level = Number(name[1]);
      const title = textOf(n);
      if (!title) return;
      while (stack.length && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
      const sec: Draft = { kind: 'section', text: title, children: [], level };
      const parent = stack[stack.length - 1];
      (parent ? parent.children : top).push(sec);
      stack.push(sec);
    } else if (name === 'ol' || name === 'ul') {
      const steps = listSteps(n);
      if (steps.length) sink().push(...steps);
    } else if (name === 'table') {
      for (const tr of descendants(n, 'tr')) {
        const cells = kids(tr).filter((c) => c.name === 'th' || c.name === 'td');
        if (cells.length === 0 || cells.every((c) => c.name === 'th')) continue;
        const text = cells.map((c) => textOf(c)).filter(Boolean).join(' | ');
        if (text) sink().push({ kind: 'row', text, children: [] });
      }
    } else if (name === 'p') {
      const text = textOf(n);
      if (text) sink().push({ kind: 'paragraph', text, children: [] });
    } else if (name === 'ac:structured-macro') {
      for (const b of bodyOf(n) ?? []) kids(b).forEach(visit);
    } else if (name === 'ac:parameter') {
      return;
    } else {
      kids(n).forEach(visit);
    }
  };

  kids(doc).forEach(visit);
  return top;
}

function finalize(drafts: Draft[], path: string[], idPrefix: string): StepNode[] {
  const counts: Record<string, number> = {};
  return drafts.map((d) => {
    const idx = counts[d.kind] ?? 0;
    counts[d.kind] = idx + 1;
    const nodePath = d.kind === 'section' ? [...path, ...(d.text ? [d.text] : [])] : path;
    // Nested steps use a dotted index ("1.0") so ids stay unique across parents.
    const index = `${idPrefix}${idx}`;
    const node: StepNode = { id: `${d.kind}:${nodePath.join('/')}:${index}`, path: nodePath, kind: d.kind, text: d.text };
    if (d.children.length) {
      node.children = finalize(d.children, nodePath, d.kind === 'step' ? `${index}.` : '');
    }
    return node;
  });
}

export function parseProcedure(xhtml: string): StepNode[] {
  return finalize(parseDrafts(xhtml), [], '');
}

export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%:\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function snapshotFromXhtml(pageId: string, version: number, xhtml: string): Snapshot {
  return {
    pageId,
    version,
    bodyHash: createHash('sha256').update(xhtml).digest('hex'),
    nodes: parseProcedure(xhtml),
  };
}
