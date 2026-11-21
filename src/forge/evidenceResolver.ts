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
  isProjectAdmin(projectKey: string): Promise<boolean>;
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

export class EvidenceUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceUploadError';
  }
}

type Req = {
  context?: { accountId?: string; extension?: { issue?: { key?: string }; project?: { key?: string } } };
};

function ctx(req: unknown): { issueKey: string; actor: string; projectKey: string } | null {
  const r = (req ?? {}) as Req;
  const issueKey = r.context?.extension?.issue?.key;
  const actor = r.context?.accountId;
  if (!issueKey || !actor) return null;
  const projectKey = r.context?.extension?.project?.key ?? issueKey.slice(0, issueKey.lastIndexOf('-'));
  return { issueKey, actor, projectKey };
}

const NO_CONTEXT = { ok: false, error: 'NO_CONTEXT', message: 'Missing issue or user context.' } as const;
const fail = (e: unknown) => {
  console.error(JSON.stringify({ tag: 'canon-resolver-error', error: e instanceof Error ? e.message : String(e) }));
  return { ok: false, error: 'INTERNAL', message: 'Something went wrong. Try again.' } as const;
};

/** On-screen pack: viewer mode, per-user canView. */
export async function evidenceHandler(req: unknown, d: EvidenceDeps): Promise<EvidenceResponse> {
  const c = ctx(req);
  if (!c) return NO_CONTEXT;
  try {
    return {
      ok: true,
      pack: await buildEvidence(d.repos, { issueKey: c.issueKey, now: d.now(), canView: d.canView, mode: 'viewer' }),
    };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Shared by the resolver and the dev harness. Files are built in issueSafe mode (every issue viewer can read
 * attachments). Audit-first: EVIDENCE_EXPORTED is written before the upload; if the upload fails an
 * EVIDENCE_EXPORT_FAILED event is appended (best effort) and EvidenceUploadError is thrown.
 */
export async function attachEvidence(d: EvidenceDeps, p: { issueKey: string; actor: string }): Promise<string[]> {
  const at = d.now();
  const pack = await buildEvidence(d.repos, { issueKey: p.issueKey, now: at, canView: d.canView, mode: 'issueSafe' });
  const base = `canon-evidence-${p.issueKey}-${at.replace(/[^0-9A-Za-z]/g, '')}`;
  const files: EvidenceFile[] = [
    { name: `${base}.json`, type: 'application/json', content: JSON.stringify(pack, null, 2) },
    { name: `${base}.html`, type: 'text/html', content: renderEvidenceHtml(pack) },
  ];
  const names = files.map((f) => f.name);

  // If this append throws, nothing is uploaded (fail closed).
  await appendAudit(d.repos.audit, {
    issueKey: p.issueKey,
    type: 'EVIDENCE_EXPORTED',
    actor: p.actor,
    at,
    payload: { files: names, headHash: pack.chain.headHash, chainOk: pack.chain.ok },
  });
  try {
    await d.upload(p.issueKey, files);
  } catch (e) {
    try {
      await appendAudit(d.repos.audit, {
        issueKey: p.issueKey,
        type: 'EVIDENCE_EXPORT_FAILED',
        actor: p.actor,
        at: d.now(),
        payload: { files: names },
      });
    } catch {
      // best effort
    }
    throw new EvidenceUploadError(e instanceof Error ? e.message : 'Upload failed');
  }
  return names;
}

export async function evidenceAttachHandler(req: unknown, d: EvidenceDeps): Promise<EvidenceAttachResponse> {
  const c = ctx(req);
  if (!c) return NO_CONTEXT;
  try {
    let admin = false;
    try {
      admin = (await d.isProjectAdmin(c.projectKey)) === true;
    } catch {
      admin = false; // fail closed
    }
    if (!admin) {
      return { ok: false, error: 'NOT_ADMIN', message: 'Only project administrators can attach the evidence pack.' };
    }
    return { ok: true, files: await attachEvidence(d, c) };
  } catch (e) {
    if (e instanceof EvidenceUploadError) {
      console.error(JSON.stringify({ tag: 'canon-resolver-error', error: e.message }));
      return { ok: false, error: 'UPLOAD_FAILED', message: 'Evidence upload failed. Try again.' };
    }
    return fail(e);
  }
}
