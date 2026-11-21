// Handlers for canonEvidence / canonEvidenceAttach. No @forge/* imports: tests pass fakes.
import { appendAudit } from '../domain/audit';
import { buildEvidence, renderEvidenceHtml, type EvidencePack } from '../domain/evidence';
import type { Repos } from '../domain/repos';

export interface EvidenceFile {
  name: string;
  type: string;
  content: string;
}

export interface EvidenceDeps {
  repos: Repos;
  canView(pageId: string): Promise<boolean>;
  /** Attaches files to the issue as the app. Must throw on failure. */
  upload(issueKey: string, files: EvidenceFile[]): Promise<void>;
  now: () => string;
}

export type EvidenceResponse =
  | { ok: true; pack: EvidencePack }
  | { ok: false; error: string; message: string };

export type EvidenceAttachResponse =
  | { ok: true; files: string[] }
  | { ok: false; error: string; message: string };

type Req = { context?: { accountId?: string; extension?: { issue?: { key?: string } } } };

function ctx(req: unknown): { issueKey: string; actor: string } | null {
  const r = (req ?? {}) as Req;
  const issueKey = r.context?.extension?.issue?.key;
  const actor = r.context?.accountId;
  return issueKey && actor ? { issueKey, actor } : null;
}

const NO_CONTEXT = { ok: false, error: 'NO_CONTEXT', message: 'Missing issue or user context.' } as const;
const fail = (e: unknown) =>
  ({ ok: false, error: 'INTERNAL', message: e instanceof Error ? e.message : 'Unexpected error' }) as const;

export async function evidenceHandler(req: unknown, d: EvidenceDeps): Promise<EvidenceResponse> {
  const c = ctx(req);
  if (!c) return NO_CONTEXT;
  try {
    return { ok: true, pack: await buildEvidence(d.repos, { issueKey: c.issueKey, now: d.now(), canView: d.canView }) };
  } catch (e) {
    return fail(e);
  }
}

/** Shared by the resolver and the dev harness. */
export async function attachEvidence(d: EvidenceDeps, p: { issueKey: string; actor: string }): Promise<string[]> {
  const at = d.now();
  const pack = await buildEvidence(d.repos, { issueKey: p.issueKey, now: at, canView: d.canView });
  const stamp = at.replace(/[^0-9A-Za-z]/g, '');
  const base = `canon-evidence-${p.issueKey}-${stamp}`;
  const files: EvidenceFile[] = [
    { name: `${base}.json`, type: 'application/json', content: JSON.stringify(pack, null, 2) },
    { name: `${base}.html`, type: 'text/html', content: renderEvidenceHtml(pack) },
  ];
  await d.upload(p.issueKey, files);
  const names = files.map((f) => f.name);
  await appendAudit(d.repos.audit, {
    issueKey: p.issueKey,
    type: 'EVIDENCE_EXPORTED',
    actor: p.actor,
    at,
    payload: { files: names, headHash: pack.chain.headHash },
  });
  return names;
}

export async function evidenceAttachHandler(req: unknown, d: EvidenceDeps): Promise<EvidenceAttachResponse> {
  const c = ctx(req);
  if (!c) return NO_CONTEXT;
  try {
    return { ok: true, files: await attachEvidence(d, c) };
  } catch (e) {
    return fail(e);
  }
}
