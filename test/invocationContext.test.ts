import { describe, expect, it } from 'vitest';
import { actorFromContext, isAdminFromMyPermissions } from '../src/forge/invocationContext';

describe('actorFromContext', () => {
  it('reads context.principal.accountId (Forge function arguments)', () => {
    expect(actorFromContext({ installContext: 'ari', principal: { accountId: '712020:abc' } })).toBe('712020:abc');
  });
  it('ignores a top-level accountId and missing/empty values', () => {
    expect(actorFromContext({ accountId: '712020:abc' })).toBeNull();
    expect(actorFromContext({ principal: { accountId: '' } })).toBeNull();
    expect(actorFromContext(undefined)).toBeNull();
  });
});

describe('isAdminFromMyPermissions', () => {
  const perms = (ap: boolean, a: boolean) => ({
    permissions: { ADMINISTER_PROJECTS: { havePermission: ap }, ADMINISTER: { havePermission: a } },
  });
  it('project admin or Jira admin passes', () => {
    expect(isAdminFromMyPermissions(perms(true, false))).toBe(true);
    expect(isAdminFromMyPermissions(perms(false, true))).toBe(true);
  });
  it('neither, or malformed, fails closed', () => {
    expect(isAdminFromMyPermissions(perms(false, false))).toBe(false);
    expect(isAdminFromMyPermissions({})).toBe(false);
    expect(isAdminFromMyPermissions(null)).toBe(false);
    expect(isAdminFromMyPermissions({ permissions: { ADMINISTER: { havePermission: 'true' } } })).toBe(false);
  });
});
