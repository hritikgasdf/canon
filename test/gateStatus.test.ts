import { describe, expect, it } from 'vitest';
import { toGateStatus } from '../src/domain/gateStatus';

const binding = { pageId: '123', boundVersion: 3, title: 'Deploy SOP' };

describe('toGateStatus', () => {
  it('NO_BINDING when there is no canon-binding property', () => {
    const s = toGateStatus({ issueKey: 'CAN-1', binding: null, currentVersion: null });
    expect(s).toEqual({
      ok: true,
      issueKey: 'CAN-1',
      bound: false,
      state: 'NO_BINDING',
      message: 'This work item is not bound to a Confluence procedure.',
    });
  });

  it('CURRENT when live version equals the bound version', () => {
    const s = toGateStatus({ issueKey: 'CAN-1', binding, currentVersion: 3 });
    expect(s.state).toBe('CURRENT');
    expect(s).toMatchObject({ ok: true, bound: true, pageId: '123', title: 'Deploy SOP', boundVersion: 3, currentVersion: 3 });
    expect(s.message).toContain('still the current version');
  });

  it('SUPERSEDED when the procedure was revised after binding', () => {
    const s = toGateStatus({ issueKey: 'CAN-1', binding, currentVersion: 5 });
    expect(s.state).toBe('SUPERSEDED');
    expect(s).toMatchObject({ bound: true, boundVersion: 3, currentVersion: 5 });
    expect(s.message).toContain('v3 → v5');
  });

  it('UNVERIFIED when the live version could not be read', () => {
    const s = toGateStatus({ issueKey: 'CAN-1', binding, currentVersion: null });
    expect(s.state).toBe('UNVERIFIED');
    expect(s).toMatchObject({ bound: true, pageId: '123', boundVersion: 3 });
    expect(s.currentVersion).toBeUndefined();
  });

  it('UNVERIFIED with the error message when a lookup failed, keeping binding context', () => {
    const s = toGateStatus({
      issueKey: 'CAN-1',
      binding: null,
      currentVersion: null,
      error: 'Canon could not read the binding (HTTP 500). Try again later.',
    });
    expect(s).toEqual({
      ok: true,
      issueKey: 'CAN-1',
      bound: false,
      state: 'UNVERIFIED',
      message: 'Canon could not read the binding (HTTP 500). Try again later.',
    });
  });

  it('error wins over a readable version and does not claim CURRENT', () => {
    const s = toGateStatus({ issueKey: 'CAN-1', binding, currentVersion: 3, error: 'boom' });
    expect(s.state).toBe('UNVERIFIED');
    expect(s.message).toBe('boom');
    expect(s).toMatchObject({ pageId: '123', boundVersion: 3 });
  });

  it('falls back to the page id in the message when the binding has no title', () => {
    const s = toGateStatus({ issueKey: 'CAN-1', binding: { pageId: '99', boundVersion: 2 }, currentVersion: 2 });
    expect(s.state).toBe('CURRENT');
    expect(s.title).toBeUndefined();
    expect(s.message).toContain('page 99');
  });
});
