// Project register resolvers. Logic is dependency-injected; real wiring lives in resolvers.ts.
import { buildRegister, verifyRegisterChains } from '../domain/register';
import type { Repos } from '../domain/repos';

export type RegisterResolverDeps = {
  repos: Repos;
  canBrowseProject(projectKey: string): Promise<boolean>;
  canView(pageId: string): Promise<boolean>;
};

type Req = { context?: { extension?: { project?: { key?: string } } } };
type Fail = { ok: false; error: 'NO_ACCESS' | 'INTERNAL'; message: string };

async function guarded<T extends object>(
  req: unknown,
  deps: RegisterResolverDeps,
  run: (projectKey: string) => Promise<T>,
): Promise<({ ok: true } & T) | Fail> {
  try {
    // The project comes from the trusted context only, never from the payload.
    const projectKey = (req as Req).context?.extension?.project?.key;
    const allowed = projectKey ? await deps.canBrowseProject(projectKey).catch(() => false) : false;
    if (!projectKey || !allowed) {
      return { ok: false, error: 'NO_ACCESS', message: 'You do not have access to this project.' };
    }
    return { ok: true, ...(await run(projectKey)) };
  } catch (e) {
    console.error('canon register resolver failed', e instanceof Error ? e.message : String(e));
    return { ok: false, error: 'INTERNAL', message: 'Something went wrong. Try again.' };
  }
}

export const registerHandler = (req: unknown, deps: RegisterResolverDeps) =>
  guarded(req, deps, async (projectKey) => ({
    register: await buildRegister({ repos: deps.repos, canView: deps.canView }, { projectKey }),
  }));

export const registerVerifyHandler = (req: unknown, deps: RegisterResolverDeps) =>
  guarded(req, deps, async (projectKey) => {
    const reg = await buildRegister({ repos: deps.repos, canView: deps.canView }, { projectKey });
    return { verification: await verifyRegisterChains(deps.repos, reg.rows.map((r) => r.issueKey)) };
  });
