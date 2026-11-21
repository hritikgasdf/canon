import { describe, expect, it } from 'vitest';
import type { Repos } from '../src/domain/repos';
import { DEFAULT_SETTINGS, type Attestation, type AuditEvent, type Binding, type Delta, type Procedure, type Snapshot } from '../src/domain/types';

const procedure = (pageId: string): Procedure => ({
  pageId,
  spaceKey: 'OPS',
  title: `Procedure ${pageId}`,
  controlled: true,
  policy: 'approved-only',
  approved: [{ version: 1, approvedBy: 'alice', approvedAt: '2026-01-01T00:00:00Z', bodyHash: 'h1', minorEdit: false }],
  currentApproved: 1,
  lastSeenVersion: 1,
});

const snapshot = (pageId: string, version: number): Snapshot => ({
  pageId,
  version,
  bodyHash: `hash-${version}`,
  nodes: [{ id: 'n1', path: ['1'], kind: 'step', text: 'Do the thing' }],
});

const binding = (id: string, issueKey: string, pageId: string, state: Binding['state']): Binding => ({
  id,
  issueKey,
  pageId,
  boundVersion: 1,
  boundAt: '2026-01-02T00:00:00Z',
  boundBy: 'bob',
  state,
});

const delta = (pageId: string, fromVersion: number, toVersion: number): Delta => ({
  pageId,
  fromVersion,
  toVersion,
  items: [
    {
      itemId: 'i1',
      path: ['1', '2'],
      kind: 'CHANGED',
      before: 'wait 5 min',
      after: 'wait 10 min',
      trivial: false,
      hints: ['DURATION'],
    },
  ],
  fromHash: 'hash-a',
  toHash: 'hash-b',
  engineVersion: '1.0.0',
});

const attestation = (bindingId: string, toVersion: number): Attestation => ({
  bindingId,
  toVersion,
  items: [{ itemId: 'i1', status: 'PENDING' }],
  implementer: 'carol',
});

const auditEvent = (issueKey: string, seq: number): AuditEvent => ({
  issueKey,
  seq,
  type: 'BOUND',
  actor: 'bob',
  at: `2026-01-0${seq}T00:00:00Z`,
  payload: { seq },
  prevHash: seq === 1 ? 'genesis' : `h${seq - 1}`,
  hash: `h${seq}`,
});

export function runRepoContract(name: string, make: () => Repos): void {
  describe(`${name} repo contract`, () => {
    describe('procedures', () => {
      it('round-trips a put procedure', async () => {
        const repos = make();
        const p = procedure('P1');
        await repos.procedures.put(p);
        expect(await repos.procedures.get('P1')).toEqual(p);
      });

      it('returns null for a missing procedure', async () => {
        expect(await make().procedures.get('nope')).toBeNull();
      });

      it('isolates stored state from caller mutation', async () => {
        const repos = make();
        const p = procedure('P1');
        await repos.procedures.put(p);
        p.approved[0].bodyHash = 'mutated';
        p.title = 'mutated';
        const got = await repos.procedures.get('P1');
        expect(got?.title).toBe('Procedure P1');
        expect(got?.approved[0].bodyHash).toBe('h1');
        got!.title = 'mutated-again';
        expect((await repos.procedures.get('P1'))?.title).toBe('Procedure P1');
      });

      it('lists only pages with open bindings (CURRENT, SUPERSEDED, REATTESTING)', async () => {
        const repos = make();
        await repos.bindings.put(binding('b1', 'OPS-1', 'P1', 'CURRENT'));
        await repos.bindings.put(binding('b2', 'OPS-2', 'P2', 'SUPERSEDED'));
        await repos.bindings.put(binding('b3', 'OPS-3', 'P3', 'REATTESTING'));
        await repos.bindings.put(binding('b4', 'OPS-4', 'P4', 'CLEARED'));
        await repos.bindings.put(binding('b5', 'OPS-5', 'P5', 'ORPHANED'));
        await repos.bindings.put(binding('b6', 'OPS-6', 'P1', 'CLEARED'));
        const pageIds = await repos.procedures.listWithOpenBindings();
        expect([...pageIds].sort()).toEqual(['P1', 'P2', 'P3']);
      });

      it('returns no pages when there are no open bindings', async () => {
        const repos = make();
        await repos.bindings.put(binding('b1', 'OPS-1', 'P1', 'CLEARED'));
        expect(await repos.procedures.listWithOpenBindings()).toEqual([]);
      });
    });

    describe('listControlled', () => {
      it('returns only procedures with controlled === true', async () => {
        const repos = make();
        await repos.procedures.put(procedure('P1'));
        await repos.procedures.put({ ...procedure('P2'), controlled: false });
        await repos.procedures.put(procedure('P3'));
        const listed = await repos.procedures.listControlled();
        expect(listed.map((p) => p.pageId).sort()).toEqual(['P1', 'P3']);
      });

      it('returns an empty list when nothing is controlled', async () => {
        const repos = make();
        expect(await repos.procedures.listControlled()).toEqual([]);
        await repos.procedures.put({ ...procedure('P1'), controlled: false });
        expect(await repos.procedures.listControlled()).toEqual([]);
      });
    });

    describe('snapshots', () => {
      it('round-trips a put snapshot by pageId and version', async () => {
        const repos = make();
        const s1 = snapshot('P1', 1);
        const s2 = snapshot('P1', 2);
        await repos.snapshots.put(s1);
        await repos.snapshots.put(s2);
        expect(await repos.snapshots.get('P1', 1)).toEqual(s1);
        expect(await repos.snapshots.get('P1', 2)).toEqual(s2);
      });

      it('returns null for a missing snapshot', async () => {
        const repos = make();
        await repos.snapshots.put(snapshot('P1', 1));
        expect(await repos.snapshots.get('P1', 2)).toBeNull();
        expect(await repos.snapshots.get('P2', 1)).toBeNull();
      });

      it('isolates stored state from caller mutation', async () => {
        const repos = make();
        const s = snapshot('P1', 1);
        await repos.snapshots.put(s);
        s.nodes[0].text = 'mutated';
        const got = await repos.snapshots.get('P1', 1);
        expect(got?.nodes[0].text).toBe('Do the thing');
        got!.nodes[0].text = 'mutated-again';
        expect((await repos.snapshots.get('P1', 1))?.nodes[0].text).toBe('Do the thing');
      });
    });

    describe('bindings', () => {
      it('round-trips a put binding by id', async () => {
        const repos = make();
        const b = binding('b1', 'OPS-1', 'P1', 'CURRENT');
        await repos.bindings.put(b);
        expect(await repos.bindings.get('b1')).toEqual(b);
      });

      it('returns null for a missing binding', async () => {
        expect(await make().bindings.get('nope')).toBeNull();
      });

      it('listByIssue returns only bindings for that issue', async () => {
        const repos = make();
        await repos.bindings.put(binding('b1', 'OPS-1', 'P1', 'CURRENT'));
        await repos.bindings.put(binding('b2', 'OPS-1', 'P2', 'CLEARED'));
        await repos.bindings.put(binding('b3', 'OPS-2', 'P1', 'CURRENT'));
        const ids = (await repos.bindings.listByIssue('OPS-1')).map((b) => b.id).sort();
        expect(ids).toEqual(['b1', 'b2']);
        expect(await repos.bindings.listByIssue('OPS-9')).toEqual([]);
      });

      it('listByPage without a state filter returns all bindings for the page', async () => {
        const repos = make();
        await repos.bindings.put(binding('b1', 'OPS-1', 'P1', 'CURRENT'));
        await repos.bindings.put(binding('b2', 'OPS-2', 'P1', 'CLEARED'));
        await repos.bindings.put(binding('b3', 'OPS-3', 'P2', 'CURRENT'));
        const ids = (await repos.bindings.listByPage('P1')).map((b) => b.id).sort();
        expect(ids).toEqual(['b1', 'b2']);
      });

      it('listByPage filters by the given states', async () => {
        const repos = make();
        await repos.bindings.put(binding('b1', 'OPS-1', 'P1', 'CURRENT'));
        await repos.bindings.put(binding('b2', 'OPS-2', 'P1', 'SUPERSEDED'));
        await repos.bindings.put(binding('b3', 'OPS-3', 'P1', 'CLEARED'));
        await repos.bindings.put(binding('b4', 'OPS-4', 'P2', 'CURRENT'));
        const ids = (await repos.bindings.listByPage('P1', ['CURRENT', 'SUPERSEDED'])).map((b) => b.id).sort();
        expect(ids).toEqual(['b1', 'b2']);
        expect(await repos.bindings.listByPage('P1', ['ORPHANED'])).toEqual([]);
      });

      it('isolates stored state from caller mutation', async () => {
        const repos = make();
        const b = binding('b1', 'OPS-1', 'P1', 'CURRENT');
        await repos.bindings.put(b);
        b.state = 'CLEARED';
        expect((await repos.bindings.get('b1'))?.state).toBe('CURRENT');
        const listed = await repos.bindings.listByIssue('OPS-1');
        listed[0].state = 'CLEARED';
        expect((await repos.bindings.get('b1'))?.state).toBe('CURRENT');
      });
    });

    describe('deltas', () => {
      it('round-trips a put delta by pageId and version range', async () => {
        const repos = make();
        const d = delta('P1', 1, 2);
        await repos.deltas.put(d);
        expect(await repos.deltas.get('P1', 1, 2)).toEqual(d);
      });

      it('returns null for a missing delta', async () => {
        const repos = make();
        await repos.deltas.put(delta('P1', 1, 2));
        expect(await repos.deltas.get('P1', 2, 3)).toBeNull();
        expect(await repos.deltas.get('P2', 1, 2)).toBeNull();
      });

      it('isolates stored state from caller mutation', async () => {
        const repos = make();
        const d = delta('P1', 1, 2);
        await repos.deltas.put(d);
        d.items[0].after = 'mutated';
        expect((await repos.deltas.get('P1', 1, 2))?.items[0].after).toBe('wait 10 min');
      });
    });

    describe('attestations', () => {
      it('round-trips a put attestation by bindingId and toVersion', async () => {
        const repos = make();
        const a = attestation('b1', 2);
        await repos.attestations.put(a);
        expect(await repos.attestations.get('b1', 2)).toEqual(a);
      });

      it('returns null for a missing attestation', async () => {
        const repos = make();
        await repos.attestations.put(attestation('b1', 2));
        expect(await repos.attestations.get('b1', 3)).toBeNull();
        expect(await repos.attestations.get('b2', 2)).toBeNull();
      });

      it('isolates stored state from caller mutation', async () => {
        const repos = make();
        const a = attestation('b1', 2);
        await repos.attestations.put(a);
        a.items[0].status = 'DONE';
        expect((await repos.attestations.get('b1', 2))?.items[0].status).toBe('PENDING');
      });
    });

    describe('audit', () => {
      it('last returns null when the issue has no events', async () => {
        expect(await make().audit.last('OPS-1')).toBeNull();
      });

      it('appends and lists events ordered by seq', async () => {
        const repos = make();
        await repos.audit.append(auditEvent('OPS-1', 2));
        await repos.audit.append(auditEvent('OPS-1', 1));
        await repos.audit.append(auditEvent('OPS-1', 3));
        await repos.audit.append(auditEvent('OPS-2', 1));
        const seqs = (await repos.audit.list('OPS-1')).map((e) => e.seq);
        expect(seqs).toEqual([1, 2, 3]);
        expect(await repos.audit.list('OPS-9')).toEqual([]);
      });

      it('last returns the event with the highest seq', async () => {
        const repos = make();
        await repos.audit.append(auditEvent('OPS-1', 1));
        await repos.audit.append(auditEvent('OPS-1', 2));
        expect(await repos.audit.last('OPS-1')).toEqual(auditEvent('OPS-1', 2));
        expect(await repos.audit.last('OPS-2')).toBeNull();
      });

      it('round-trips event payloads', async () => {
        const repos = make();
        const e = auditEvent('OPS-1', 1);
        await repos.audit.append(e);
        expect((await repos.audit.list('OPS-1'))[0]).toEqual(e);
      });

      it('isolates stored state from caller mutation', async () => {
        const repos = make();
        const e = auditEvent('OPS-1', 1);
        await repos.audit.append(e);
        e.payload.seq = 999;
        expect((await repos.audit.last('OPS-1'))?.payload).toEqual({ seq: 1 });
      });
    });

    describe('settings', () => {
      it('returns the default settings before anything is stored', async () => {
        expect(await make().settings.get()).toEqual(DEFAULT_SETTINGS);
      });

      it('round-trips a put settings value', async () => {
        const repos = make();
        const s = {
          revisionPolicy: 'every-major' as const,
          validatorMode: 'warn' as const,
          autoBind: { 'OPS-PROJECT': 'P1' },
          requireIndependentApprover: false,
        };
        await repos.settings.put(s);
        expect(await repos.settings.get()).toEqual(s);
      });

      it('isolates stored state from caller mutation', async () => {
        const repos = make();
        const s = await repos.settings.get();
        s.autoBind.X = 'mutated';
        expect((await repos.settings.get()).autoBind).toEqual({});
      });
    });
  });
}
