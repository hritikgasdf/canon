import { describe, expect, it, vi } from 'vitest';
import { assignChecker, sign } from '../src/domain/attest';
import { appendAudit } from '../src/domain/audit';
import { buildEvidence, escapeHtml, renderEvidenceHtml } from '../src/domain/evidence';
import { createMemoryRepos } from '../src/domain/memoryRepos';
import type { Repos } from '../src/domain/repos';
import type { Attestation } from '../src/domain/types';
import { evidenceAttachHandler, evidenceHandler, type EvidenceDeps } from '../src/forge/evidenceResolver';

const NOW = '2026-11-21T10:00:00.000Z';
const K = 'CAN-1';

async function setup(opts: { sealed?: boolean } = {}): Promise<Repos> {
  const repos = createMemoryRepos();
  await repos.procedures.put({
    pageId: 'p1',
    title: 'Secret SOP',
    controlled: true,
    policy: 'approved-only',
    approved: [{ version: 4, approvedBy: 'boss', approvedAt: NOW, bodyHash: 'h4', minorEdit: false }],
    currentApproved: 4,
    lastSeenVersion: 4,
  });
  await repos.bindings.put({
    id: 'CAN-1.p1',
    issueKey: K,
    pageId: 'p1',
    boundVersion: 3,
    boundAt: NOW,
    boundBy: 'u',
    state: 'SUPERSEDED',
    supersededBy: 4,
  });
  let att: Attestation = {
    bindingId: 'CAN-1.p1',
    toVersion: 4,
    implementer: 'impl',
    items: [{ itemId: 'i1', status: 'DONE', by: 'impl', at: NOW, note: 'sensitive note' }],
  };
  if (opts.sealed) att = sign(assignChecker(att, { checker: 'chk' }), { actor: 'chk', at: NOW });
  await repos.attestations.put(att);
  for (let i = 0; i < 3; i++) {
    await appendAudit(repos.audit, { issueKey: K, type: 'T', actor: 'u', at: NOW, payload: { i } });
  }
  return repos;
}

const all = async () => true;

describe('buildEvidence', () => {
  it('reports a verified chain', async () => {
    const pack = await buildEvidence(await setup(), { issueKey: K, now: NOW, canView: all });
    expect(pack.schema).toBe('canon-evidence/1');
    expect(pack.chain.ok).toBe(true);
    expect(pack.chain.count).toBe(3);
    expect(pack.chain.headHash).toBe(pack.audit[2].hash);
    expect(pack.bindings[0].approvedVersions?.[0].contentHash).toBe('h4');
  });

  it('reports brokenAt for a tampered chain', async () => {
    const repos = await setup();
    const list = await repos.audit.list(K);
    const bad = { ...list[1], payload: { i: 99 } };
    const spy: Repos = { ...repos, audit: { ...repos.audit, list: async () => [list[0], bad, list[2]] } };
    const pack = await buildEvidence(spy, { issueKey: K, now: NOW, canView: all });
    expect(pack.chain.ok).toBe(false);
    expect(pack.chain.brokenAt).toBe(2);
    expect(pack.chain.headHash).toBeNull();
  });

  it('omits title, approvals and attestation for restricted bindings', async () => {
    const pack = await buildEvidence(await setup({ sealed: true }), { issueKey: K, now: NOW, canView: async () => false });
    const b = pack.bindings[0];
    expect(b.restricted).toBe(true);
    expect(b.title).toBeUndefined();
    expect(b.approvedVersions).toBeUndefined();
    expect(b.attestations).toBeUndefined();
    expect(JSON.stringify(pack)).not.toContain('Secret SOP');
    expect(JSON.stringify(pack)).not.toContain('sensitive note');
  });

  it('treats a throwing canView as restricted', async () => {
    const pack = await buildEvidence(await setup(), {
      issueKey: K,
      now: NOW,
      canView: async () => {
        throw new Error('x');
      },
    });
    expect(pack.bindings[0].restricted).toBe(true);
  });

  it('marks a sealed attestation sealValid', async () => {
    const pack = await buildEvidence(await setup({ sealed: true }), { issueKey: K, now: NOW, canView: all });
    expect(pack.bindings[0].attestations?.[0].sealValid).toBe(true);
    expect(pack.bindings[0].attestations?.[0].checker).toBe('chk');
  });

  it('marks an attestation edited after sealing sealValid false', async () => {
    const repos = await setup({ sealed: true });
    const a = (await repos.attestations.get('CAN-1.p1', 4))!;
    await repos.attestations.put({ ...a, items: [{ ...a.items[0], status: 'NOT_MATERIAL' }] });
    const pack = await buildEvidence(repos, { issueKey: K, now: NOW, canView: all });
    expect(pack.bindings[0].attestations?.[0].sealValid).toBe(false);
  });
});

describe('renderEvidenceHtml', () => {
  it('escapes <script>, quotes and ampersands', async () => {
    expect(escapeHtml(`<script>"a" & 'b'</script>`)).toBe('&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;');
    const repos = await setup();
    await repos.procedures.put({ ...(await repos.procedures.get('p1'))!, title: '<script>alert(1)</script>' });
    const pack = await buildEvidence(repos, { issueKey: K, now: NOW, canView: all });
    const html = renderEvidenceHtml(pack);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('contains the chain badge, and the broken variant', async () => {
    const pack = await buildEvidence(await setup(), { issueKey: K, now: NOW, canView: all });
    const html = renderEvidenceHtml(pack);
    expect(html).toContain('Audit chain verified: 3 events');
    expect(html).toContain(pack.audit[0].hash.slice(0, 12));
    expect(renderEvidenceHtml({ ...pack, chain: { ok: false, count: 3, brokenAt: 2, headHash: null } })).toContain(
      'Audit chain BROKEN at event 2',
    );
  });
});

describe('evidence resolvers', () => {
  const ctx = { accountId: 'acc', extension: { issue: { key: K } } };
  async function deps() {
    const repos = await setup();
    const upload = vi.fn(async () => undefined);
    const d: EvidenceDeps = { repos, canView: all, isProjectAdmin: async () => true, upload, now: () => NOW };
    return { repos, upload, d };
  }

  it('returns NOT_ADMIN (and does nothing) for non-admins and failing admin checks', async () => {
    const { d, upload, repos } = await deps();
    d.isProjectAdmin = async () => false;
    expect(await evidenceAttachHandler({ context: ctx }, d)).toMatchObject({ ok: false, error: 'NOT_ADMIN' });
    d.isProjectAdmin = async () => {
      throw new Error('jira down');
    };
    expect(await evidenceAttachHandler({ context: ctx }, d)).toMatchObject({ ok: false, error: 'NOT_ADMIN' });
    expect(upload).not.toHaveBeenCalled();
    expect((await repos.audit.last(K))?.type).toBe('T');
  });

  it('passes the project key to isProjectAdmin', async () => {
    const { d } = await deps();
    const spy = vi.fn(async () => true);
    d.isProjectAdmin = spy;
    await evidenceAttachHandler({ context: ctx }, d);
    expect(spy).toHaveBeenCalledWith('CAN');
  });

  it('attached files are issueSafe', async () => {
    const { d, upload } = await deps();
    await evidenceAttachHandler({ context: ctx }, d);
    const files = (upload.mock.calls[0] as unknown as [string, { content: string }[]])[1];
    expect(files[0].content).toContain('"mode": "issueSafe"');
    expect(files[0].content).not.toContain('Secret SOP');
    expect(files[1].content).not.toContain('Secret SOP');
  });

  it('returns NO_CONTEXT without issue or account', async () => {
    const { d, upload } = await deps();
    expect(await evidenceHandler({ context: {} }, d)).toMatchObject({ ok: false, error: 'NO_CONTEXT' });
    expect(await evidenceAttachHandler({ context: { extension: { issue: { key: K } } } }, d)).toMatchObject({
      ok: false,
      error: 'NO_CONTEXT',
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it('canonEvidence returns the pack', async () => {
    const { d } = await deps();
    const r = await evidenceHandler({ context: ctx }, d);
    expect(r.ok && r.pack.issueKey).toBe(K);
  });

  it('attach uploads 2 files and writes the audit event', async () => {
    const { d, upload, repos } = await deps();
    const r = await evidenceAttachHandler({ context: ctx }, d);
    expect(r.ok).toBe(true);
    const files = (upload.mock.calls[0] as unknown as [string, { name: string }[]])[1];
    expect(files).toHaveLength(2);
    expect(files[0].name).toMatch(/^canon-evidence-CAN-1-.*\.json$/);
    expect(files[1].name).toMatch(/\.html$/);
    const last = await repos.audit.last(K);
    expect(last?.type).toBe('EVIDENCE_EXPORTED');
    expect(last?.actor).toBe('acc');
    expect(last?.payload.files).toEqual(files.map((f) => f.name));
    expect(last?.payload.chainOk).toBe(true);
    expect(typeof last?.payload.headHash).toBe('string');
  });

  it('audits BEFORE uploading', async () => {
    const { d, repos } = await deps();
    let seenAtUpload: string | undefined;
    d.upload = async () => {
      seenAtUpload = (await repos.audit.last(K))?.type;
    };
    await evidenceAttachHandler({ context: ctx }, d);
    expect(seenAtUpload).toBe('EVIDENCE_EXPORTED');
  });

  it('returns UPLOAD_FAILED and appends EVIDENCE_EXPORT_FAILED when upload throws', async () => {
    const { d, repos } = await deps();
    d.upload = async () => {
      throw new Error('boom');
    };
    const r = await evidenceAttachHandler({ context: ctx }, d);
    expect(r).toMatchObject({ ok: false, error: 'UPLOAD_FAILED' });
    const events = await repos.audit.list(K);
    expect(events.slice(-2).map((x) => x.type)).toEqual(['EVIDENCE_EXPORTED', 'EVIDENCE_EXPORT_FAILED']);
    expect(events[events.length - 1].payload.files).toEqual(events[events.length - 2].payload.files);
  });

  it('does not upload when the pre-upload audit append fails', async () => {
    const { d, repos, upload } = await deps();
    d.repos = { ...repos, audit: { ...repos.audit, append: async () => Promise.reject(new Error('kvs down')) } };
    const r = await evidenceAttachHandler({ context: ctx }, d);
    expect(r).toMatchObject({ ok: false, error: 'INTERNAL', message: 'Something went wrong. Try again.' });
    expect(JSON.stringify(r)).not.toContain('kvs down');
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('issueSafe mode', () => {
  async function secretRepos(): Promise<Repos> {
    const repos = await setup({ sealed: true });
    const b = (await repos.bindings.get('CAN-1.p1'))!;
    await repos.bindings.put({ ...b, override: { by: 'adm', at: NOW, reason: 'TOP SECRET REASON', forVersion: 4 } });
    const a = (await repos.attestations.get('CAN-1.p1', 4))!;
    await repos.attestations.put({ ...a, items: [{ ...a.items[0], note: 'private note', rovoTask: 'rt' }] });
    await appendAudit(repos.audit, {
      issueKey: K,
      type: 'BREAK_GLASS',
      actor: 'adm',
      at: NOW,
      payload: { bindingId: 'CAN-1.p1', forVersion: 4, reason: 'TOP SECRET REASON', note: 'n' },
    });
    return repos;
  }

  it('strips titles, approval details, notes and override reason', async () => {
    const pack = await buildEvidence(await secretRepos(), { issueKey: K, now: NOW, canView: all, mode: 'issueSafe' });
    const json = JSON.stringify(pack);
    expect(json).not.toContain('Secret SOP');
    expect(json).not.toContain('TOP SECRET REASON');
    expect(json).not.toContain('private note');
    expect(json).not.toContain('rt"');
    expect(json).not.toContain('boss');
    const b = pack.bindings[0];
    expect(b.title).toBeUndefined();
    expect(b.approvedVersions).toEqual([{ version: 4, contentHash: 'h4' }]);
    expect(Object.keys(b.attestations![0].items[0]).sort()).toEqual(['at', 'by', 'itemId', 'status']);
    expect(b.override).toMatchObject({ by: 'adm', forVersion: 4, redacted: true });
  });

  it('whitelists audit payload keys and marks redaction', async () => {
    const pack = await buildEvidence(await secretRepos(), { issueKey: K, now: NOW, canView: all, mode: 'issueSafe' });
    const bg = pack.audit.find((e) => e.type === 'BREAK_GLASS')!;
    expect(bg.payload).toEqual({ bindingId: 'CAN-1.p1', forVersion: 4, redacted: true });
    // chain verdict is computed on the real events, so it stays valid
    expect(pack.chain.ok).toBe(true);
  });

  it('viewer mode keeps full detail', async () => {
    const pack = await buildEvidence(await secretRepos(), { issueKey: K, now: NOW, canView: all });
    expect(pack.mode).toBe('viewer');
    expect(JSON.stringify(pack)).toContain('private note');
    expect(pack.bindings[0].title).toBe('Secret SOP');
  });
});

describe('historical attestations', () => {
  it('lists audited and current attestations once each, with sealValid', async () => {
    const repos = await setup({ sealed: true });
    const old: Attestation = sign(
      assignChecker(
        { bindingId: 'CAN-1.p1', toVersion: 3, implementer: 'impl', items: [{ itemId: 'o', status: 'DONE' }] },
        { checker: 'chk' },
      ),
      { actor: 'chk', at: NOW },
    );
    await repos.attestations.put(old);
    for (const type of ['REATTEST_STARTED', 'SIGNED_OFF']) {
      await appendAudit(repos.audit, { issueKey: K, type, actor: 'u', at: NOW, payload: { bindingId: 'CAN-1.p1', toVersion: 3 } });
    }
    await appendAudit(repos.audit, { issueKey: K, type: 'SIGNED_OFF', actor: 'u', at: NOW, payload: { bindingId: 'CAN-1.p1', toVersion: 4 } });
    const pack = await buildEvidence(repos, { issueKey: K, now: NOW, canView: all });
    const atts = pack.bindings[0].attestations!;
    expect(atts.map((a) => a.toVersion)).toEqual([3, 4]);
    expect(atts.every((a) => a.sealValid)).toBe(true);
  });
});
