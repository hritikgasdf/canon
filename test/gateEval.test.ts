import { describe, expect, it } from 'vitest';
import { evaluateGate, GATE_FAIL_CLOSED, type GateInput } from '../src/domain/gateEval';
import type { Attestation, Binding, Procedure } from '../src/domain/types';

const bind = (over: Partial<Binding> = {}): Binding => ({
  id: 'b1',
  issueKey: 'CHG-41',
  pageId: '1',
  boundVersion: 3,
  boundAt: '2026-01-01T00:00:00Z',
  boundBy: 'u',
  state: 'CURRENT',
  ...over,
});

const proc = (over: Partial<Procedure> = {}): Procedure => ({
  pageId: '1',
  title: 'SOP-PAY-014',
  controlled: true,
  policy: 'approved-only',
  approved: [],
  currentApproved: 3,
  lastSeenVersion: 3,
  ...over,
});

const att = (over: Partial<Attestation> = {}): Attestation => ({
  bindingId: 'b1',
  toVersion: 4,
  implementer: 'u',
  items: [
    { itemId: 'a', status: 'DONE' },
    { itemId: 'b', status: 'NOT_MATERIAL' },
  ],
  checker: 'c',
  checkerSignedAt: '2026-01-02T00:00:00Z',
  sealHash: 'h',
  ...over,
});

const input = (over: Partial<GateInput> = {}): GateInput => ({
  issueKey: 'CHG-41',
  mode: 'block',
  bindings: [bind()],
  procedures: { '1': proc() },
  liveVersions: { '1': 3 },
  attestations: {},
  ...over,
});

type Case = { name: string; input: GateInput; allow: boolean; warnOnly?: boolean; codes: string[] };

const cases: Case[] = [
  { name: 'current binding allows', input: input(), allow: true, codes: [] },
  { name: 'no bindings allows', input: input({ bindings: [] }), allow: true, codes: [] },
  {
    name: 'newer approved blocks as SUPERSEDED',
    input: input({ procedures: { '1': proc({ currentApproved: 4 }) }, liveVersions: { '1': 4 } }),
    allow: false,
    codes: ['SUPERSEDED'],
  },
  {
    name: 'sealed attestation satisfies',
    input: input({
      procedures: { '1': proc({ currentApproved: 4 }) },
      liveVersions: { '1': 4 },
      attestations: { b1: att() },
    }),
    allow: true,
    codes: [],
  },
  {
    name: 'unsealed attestation (no seal) -> REATTESTING',
    input: input({
      procedures: { '1': proc({ currentApproved: 4 }) },
      liveVersions: { '1': 4 },
      attestations: { b1: att({ sealHash: undefined }) },
    }),
    allow: false,
    codes: ['REATTESTING'],
  },
  {
    name: 'sealed but pending item -> REATTESTING',
    input: input({
      procedures: { '1': proc({ currentApproved: 4 }) },
      liveVersions: { '1': 4 },
      attestations: { b1: att({ items: [{ itemId: 'a', status: 'PENDING' }] }) },
    }),
    allow: false,
    codes: ['REATTESTING'],
  },
  {
    name: 'attestation for older toVersion does not satisfy',
    input: input({
      procedures: { '1': proc({ currentApproved: 5 }) },
      liveVersions: { '1': 5 },
      attestations: { b1: att({ toVersion: 4 }) },
    }),
    allow: false,
    codes: ['SUPERSEDED'],
  },
  {
    name: 'CLEARED with no newer approval is ignored',
    input: input({
      bindings: [bind({ state: 'CLEARED', supersededBy: 4 })],
      procedures: { '1': proc({ currentApproved: 4 }) },
      liveVersions: { '1': 4 },
    }),
    allow: true,
    codes: [],
  },
  {
    name: 'CLEARED then newer approval blocks again',
    input: input({
      bindings: [bind({ state: 'CLEARED', supersededBy: 4 })],
      procedures: { '1': proc({ currentApproved: 5 }) },
      liveVersions: { '1': 5 },
    }),
    allow: false,
    codes: ['SUPERSEDED'],
  },
  {
    name: 'CLEARED without supersededBy uses boundVersion',
    input: input({
      bindings: [bind({ state: 'CLEARED' })],
      procedures: { '1': proc({ currentApproved: 4 }) },
      liveVersions: { '1': 4 },
    }),
    allow: false,
    codes: ['SUPERSEDED'],
  },
  {
    name: 'binding state ORPHANED blocks',
    input: input({ bindings: [bind({ state: 'ORPHANED' })] }),
    allow: false,
    codes: ['ORPHANED'],
  },
  {
    name: 'live NOT_FOUND blocks as ORPHANED',
    input: input({ liveVersions: { '1': 'NOT_FOUND' } }),
    allow: false,
    codes: ['ORPHANED'],
  },
  {
    name: 'procedure.orphaned blocks',
    input: input({ procedures: { '1': proc({ orphaned: true }) } }),
    allow: false,
    codes: ['ORPHANED'],
  },
  {
    name: 'live version check failed (null) -> UNVERIFIED',
    input: input({ liveVersions: { '1': null } }),
    allow: false,
    codes: ['UNVERIFIED'],
  },
  {
    name: 'live version missing -> UNVERIFIED',
    input: input({ liveVersions: {} }),
    allow: false,
    codes: ['UNVERIFIED'],
  },
  {
    name: 'missing procedure -> UNVERIFIED',
    input: input({ procedures: { '1': null } }),
    allow: false,
    codes: ['UNVERIFIED'],
  },
  {
    name: 'every-major live edit blocks',
    input: input({ procedures: { '1': proc({ policy: 'every-major' }) }, liveVersions: { '1': 4 } }),
    allow: false,
    codes: ['SUPERSEDED'],
  },
  {
    name: 'approved-only draft does not block',
    input: input({ liveVersions: { '1': 4 } }),
    allow: true,
    codes: [],
  },
  {
    name: 'multi-binding: one current + one superseded blocks',
    input: input({
      bindings: [bind(), bind({ id: 'b2', pageId: '2' })],
      procedures: { '1': proc(), '2': proc({ pageId: '2', title: 'Other', currentApproved: 4 }) },
      liveVersions: { '1': 3, '2': 4 },
    }),
    allow: false,
    codes: ['SUPERSEDED'],
  },
  {
    name: 'warn mode allows but keeps reasons',
    input: input({
      mode: 'warn',
      procedures: { '1': proc({ currentApproved: 4 }) },
      liveVersions: { '1': 4 },
    }),
    allow: true,
    warnOnly: true,
    codes: ['SUPERSEDED'],
  },
];

describe('evaluateGate (full)', () => {
  it.each(cases)('$name', (c) => {
    const d = evaluateGate(c.input);
    expect(d.allow).toBe(c.allow);
    expect(d.warnOnly).toBe(c.warnOnly ?? false);
    expect(d.reasons.map((r) => r.code)).toEqual(c.codes);
  });

  it('SUPERSEDED message without count', () => {
    const d = evaluateGate(input({ procedures: { '1': proc({ currentApproved: 4 }) }, liveVersions: { '1': 4 } }));
    expect(d.message).toContain('"SOP-PAY-014" was revised v3 → v4 while CHG-41 was open.');
    expect(d.reasons[0]).toMatchObject({ targetVersion: 4, boundVersion: 3 });
  });

  it('REATTESTING message counts open items', () => {
    const d = evaluateGate(
      input({
        procedures: { '1': proc({ currentApproved: 4 }) },
        liveVersions: { '1': 4 },
        attestations: {
          b1: att({
            checkerSignedAt: undefined,
            items: [
              { itemId: 'a', status: 'PENDING' },
              { itemId: 'b', status: 'PENDING' },
              { itemId: 'c', status: 'PENDING' },
              { itemId: 'd', status: 'DONE' },
            ],
          }),
        },
      }),
    );
    expect(d.reasons[0]?.openItems).toBe(3);
    expect(d.message).toBe(
      'Canon: "SOP-PAY-014" was revised v3 → v4 while CHG-41 was open. 3 changes need re-attestation in the Canon panel.',
    );
  });

  it('ORPHANED message falls back to page id', () => {
    const d = evaluateGate(input({ procedures: { '1': null }, liveVersions: { '1': 'NOT_FOUND' } }));
    expect(d.message).toBe(
      'Canon: the bound procedure "page 1" was deleted, archived or is no longer visible to Canon.',
    );
  });

  it('UNVERIFIED uses the fail-closed message even with other reasons', () => {
    const d = evaluateGate(
      input({
        bindings: [bind(), bind({ id: 'b2', pageId: '2' })],
        procedures: { '1': proc({ currentApproved: 4 }), '2': null },
        liveVersions: { '1': 4, '2': null },
      }),
    );
    expect(d.message).toBe(GATE_FAIL_CLOSED);
  });

  it('thrown getter fails closed', () => {
    const bad = {
      issueKey: 'CHG-41',
      mode: 'block',
      get bindings(): Binding[] {
        throw new Error('boom');
      },
      procedures: {},
      liveVersions: {},
      attestations: {},
    } as GateInput;
    expect(evaluateGate(bad)).toEqual({ allow: false, warnOnly: false, reasons: [], message: GATE_FAIL_CLOSED });
  });
});
