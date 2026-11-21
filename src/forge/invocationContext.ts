// Pure helpers for Forge function arguments (no @forge imports, so they are unit-testable).

/**
 * The acting user of a Forge function invocation. Forge passes it as `context.principal.accountId`
 * (Function Arguments reference). Never read from action inputs.
 */
export function actorFromContext(context: unknown): string | null {
  const c = context as { principal?: { accountId?: unknown } } | null | undefined;
  const id = c?.principal?.accountId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** Project admin for Canon = ADMINISTER_PROJECTS on the project, or Jira admin (ADMINISTER). */
export function isAdminFromMyPermissions(json: unknown): boolean {
  const p = (json as { permissions?: Record<string, { havePermission?: unknown }> } | null | undefined)?.permissions;
  return p?.ADMINISTER_PROJECTS?.havePermission === true || p?.ADMINISTER?.havePermission === true;
}
