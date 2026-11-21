// Evidence pack: pure assembly + printable HTML rendering. No @forge/* imports.
import { verifyChain } from './audit';
import { actorLabel, eventLabel } from './evidenceLabels';
import { verifySeal } from './attest';
import type { Repos } from './repos';
import type { AttestationItem, AuditEvent, Binding, BindingState } from './types';

/** viewer: per-user canView, full detail. issueSafe: for files attached to the issue (visible to every issue viewer). */
export type EvidenceMode = 'viewer' | 'issueSafe';

export interface EvidenceAttestation {
  toVersion: number;
  implementer: string;
  checker?: string;
  checkerSignedAt?: string;
  sealHash?: string;
  sealValid: boolean;
  items: AttestationItem[];
}

export interface EvidenceBinding {
  id: string;
  pageId: string;
  state: BindingState;
  boundVersion: number;
  supersededBy?: number;
  restricted: boolean;
  title?: string;
  approvedVersions?: Array<{ version: number; approvedBy?: string; approvedAt?: string; contentHash?: string }>;
  attestations?: EvidenceAttestation[];
  override?: Partial<NonNullable<Binding['override']>> & { redacted?: true };
}

export interface EvidencePack {
  schema: 'canon-evidence/1';
  mode: EvidenceMode;
  issueKey: string;
  generatedAt: string;
  chain: { ok: boolean; count: number; brokenAt?: number; headHash: string | null };
  bindings: EvidenceBinding[];
  audit: AuditEvent[];
  /** accountId → display name (best effort). */
  actorNames?: Record<string, string>;
}

export { actorIds, actorLabel, eventLabel } from './evidenceLabels';

/** Payload keys that hold only numbers, ids or hashes. Everything else is dropped in issueSafe mode. */
export const SAFE_PAYLOAD_KEYS = [
  'pageId',
  'bindingId',
  'version',
  'toVersion',
  'fromVersion',
  'forVersion',
  'sealHash',
  'headHash',
  'files',
  'itemId',
  'action',
  'priorState',
] as const;

const isScalarSafe = (v: unknown): boolean => typeof v === 'number' || typeof v === 'string' || v === null;

export function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let dropped = false;
  for (const [k, v] of Object.entries(payload)) {
    const ok =
      (SAFE_PAYLOAD_KEYS as readonly string[]).includes(k) &&
      (isScalarSafe(v) || (k === 'files' && Array.isArray(v) && v.every((x) => typeof x === 'string')));
    if (ok) out[k] = v;
    else dropped = true;
  }
  if (dropped) out.redacted = true;
  return out;
}

export async function buildEvidence(
  repos: Repos,
  p: { issueKey: string; now: string; canView(pageId: string): Promise<boolean>; mode?: EvidenceMode },
): Promise<EvidencePack> {
  const mode: EvidenceMode = p.mode ?? 'viewer';
  const safe = mode === 'issueSafe';
  const fullAudit = await repos.audit.list(p.issueKey);
  const c = verifyChain(fullAudit);
  const chain: EvidencePack['chain'] = c.ok
    ? { ok: true, count: fullAudit.length, headHash: fullAudit.length > 0 ? c.head : null }
    : { ok: false, count: fullAudit.length, brokenAt: c.brokenAt, headHash: null };

  const attestedVersions = (bindingId: string): number[] =>
    fullAudit
      .filter(
        (ev) =>
          (ev.type === 'REATTEST_STARTED' || ev.type === 'SIGNED_OFF') &&
          ev.payload.bindingId === bindingId &&
          typeof ev.payload.toVersion === 'number',
      )
      .map((ev) => ev.payload.toVersion as number);

  const bindings: EvidenceBinding[] = [];
  for (const b of await repos.bindings.listByIssue(p.issueKey)) {
    let visible = false;
    try {
      visible = (await p.canView(b.pageId)) === true;
    } catch {
      visible = false;
    }
    const base: EvidenceBinding = {
      id: b.id,
      pageId: b.pageId,
      state: b.state,
      boundVersion: b.boundVersion,
      ...(b.supersededBy !== undefined ? { supersededBy: b.supersededBy } : {}),
      restricted: !visible,
    };
    if (!visible) {
      bindings.push(base);
      continue;
    }
    const proc = await repos.procedures.get(b.pageId);
    const full: EvidenceBinding = { ...base };
    if (proc) {
      if (!safe) full.title = proc.title;
      full.approvedVersions = proc.approved.map((a) =>
        safe
          ? { version: a.version, contentHash: a.bodyHash }
          : { version: a.version, approvedBy: a.approvedBy, approvedAt: a.approvedAt, contentHash: a.bodyHash },
      );
    }

    const versions = new Set(attestedVersions(b.id));
    const target = b.supersededBy ?? proc?.currentApproved ?? null;
    if (target !== null && target > b.boundVersion) versions.add(target);
    const attestations: EvidenceAttestation[] = [];
    for (const v of [...versions].sort((x, y) => x - y)) {
      const a = await repos.attestations.get(b.id, v);
      if (!a) continue;
      attestations.push({
        toVersion: a.toVersion,
        implementer: a.implementer,
        ...(a.checker !== undefined ? { checker: a.checker } : {}),
        ...(a.checkerSignedAt !== undefined ? { checkerSignedAt: a.checkerSignedAt } : {}),
        ...(a.sealHash !== undefined ? { sealHash: a.sealHash } : {}),
        sealValid: verifySeal(a),
        items: safe
          ? a.items.map((i) => ({
              itemId: i.itemId,
              status: i.status,
              ...(i.by !== undefined ? { by: i.by } : {}),
              ...(i.at !== undefined ? { at: i.at } : {}),
            }))
          : a.items,
      });
    }
    if (attestations.length > 0) full.attestations = attestations;
    if (b.override) {
      full.override = safe
        ? { by: b.override.by, at: b.override.at, forVersion: b.override.forVersion, redacted: true }
        : b.override;
    }
    bindings.push(full);
  }

  const audit = safe ? fullAudit.map((ev) => ({ ...ev, payload: redactPayload(ev.payload) })) : fullAudit;
  return { schema: 'canon-evidence/1', mode, issueKey: p.issueKey, generatedAt: p.now, chain, bindings, audit };
}

export function escapeHtml(v: unknown): string {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const e = escapeHtml;

export function renderEvidenceHtml(pack: EvidencePack): string {
  const badge = pack.chain.ok
    ? `Audit chain verified: ${pack.chain.count} events`
    : `Audit chain BROKEN at event ${pack.chain.brokenAt}`;

  const bindingRows = pack.bindings
    .map(
      (b) =>
        `<tr><td>${e(b.id)}</td><td>${e(b.pageId)}</td><td>${e(b.restricted ? '(restricted)' : (b.title ?? ''))}</td>` +
        `<td>${e(b.state)}</td><td>${e(b.boundVersion)}</td><td>${e(b.supersededBy ?? '')}</td></tr>`,
    )
    .join('');

  const attestations = pack.bindings
    .flatMap((b) => (b.attestations ?? []).map((a) => ({ b, a })))
    .map(({ b, a }) => {
      const items = a.items
        .map(
          (i) =>
            `<tr><td>${e(i.itemId)}</td><td>${e(i.status)}</td><td>${e(i.by ?? '')}</td><td>${e(i.at ?? '')}</td><td>${e(i.note ?? '')}</td></tr>`,
        )
        .join('');
      return (
        `<h3>Attestation ${e(b.id)} → v${e(a.toVersion)}</h3>` +
        `<p>Implementer: ${e(a.implementer)}; checker: ${e(a.checker ?? '—')}; signed: ${e(a.checkerSignedAt ?? '—')}; ` +
        `seal: ${a.sealHash ? (a.sealValid ? 'valid' : 'INVALID') : 'not sealed'}</p>` +
        `<table><tr><th>Item</th><th>Status</th><th>By</th><th>At</th><th>Note</th></tr>${items}</table>`
      );
    })
    .join('');

  const auditRows = pack.audit
    .map(
      (ev) =>
        `<tr><td>${e(ev.seq)}</td><td>${e(ev.at)}</td><td>${e(ev.type)}</td><td>${e(eventLabel(ev, pack.actorNames))}</td><td>${e(actorLabel(ev.actor, pack.actorNames))}</td><td class="mono">${e(ev.hash.slice(0, 12))}</td></tr>`,
    )
    .join('');

  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Canon evidence ${e(pack.issueKey)}</title>` +
    `<style>body{font-family:Arial,sans-serif;margin:24px;color:#172b4d}` +
    `table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #999;padding:4px 6px;text-align:left;font-size:12px}` +
    `.mono{font-family:monospace}.badge{display:inline-block;padding:4px 10px;border:2px solid;font-weight:bold}` +
    `.ok{color:#006644}.bad{color:#bf2600}@media print{body{margin:0}}</style></head><body>` +
    `<h1>Canon evidence pack: ${e(pack.issueKey)}</h1>` +
    `<p>Generated at ${e(pack.generatedAt)} (${e(pack.mode)})</p>` +
    `<p class="badge ${pack.chain.ok ? 'ok' : 'bad'}">${e(badge)}</p>` +
    `<h2>Bindings</h2><table><tr><th>Binding</th><th>Page</th><th>Title</th><th>State</th><th>Bound v</th><th>Superseded by</th></tr>${bindingRows}</table>` +
    `<h2>Attestations</h2>${attestations || '<p>None.</p>'}` +
    `<h2>Audit timeline</h2><table><tr><th>Seq</th><th>At</th><th>Type</th><th>Event</th><th>Actor</th><th>Hash</th></tr>${auditRows}</table>` +
    `</body></html>`
  );
}
