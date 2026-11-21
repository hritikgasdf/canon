import type { Repos } from './repos';

export type SetupCheck = {
  id: 'confluence' | 'space-access' | 'gate' | 'policy' | 'auto-bind' | 'procedures';
  status: 'ok' | 'warn' | 'fail';
  title: string;
  detail: string;
  fix?: string;
};

export type SetupDeps = {
  repos: Repos;
  confluenceReachable(): Promise<boolean>;
  pageReadable(pageId: string): Promise<boolean>;
  now(): string;
};

type Id = SetupCheck['id'];

async function safe(id: Id, title: string, run: () => Promise<SetupCheck>): Promise<SetupCheck> {
  try {
    return await run();
  } catch {
    return { id, status: 'fail', title, detail: 'Could not check (error)' };
  }
}

const SPACE_FIX =
  'In Confluence: Space settings → Users → Add people and agents → search "Canon" → pick a role → Add. Or Load sample data into a new space.';

export async function runSetupChecks(deps: SetupDeps): Promise<{ checks: SetupCheck[] }> {
  const { repos } = deps;
  // Shared by three checks; a failure here fails each of them individually.
  const controlledP = repos.procedures.listControlled();
  controlledP.catch(() => undefined);

  const checks = await Promise.all([
    safe('confluence', 'Confluence connection', async () => {
      if (await deps.confluenceReachable()) {
        return { id: 'confluence', status: 'ok', title: 'Confluence connection', detail: 'Canon can reach Confluence' };
      }
      return {
        id: 'confluence',
        status: 'fail',
        title: 'Confluence connection',
        detail: 'Canon cannot reach Confluence on this site',
        fix: 'Install Canon in Confluence on this site (same app, Confluence product).',
      };
    }),
    safe('space-access', 'Space access', async () => {
      const controlled = await controlledP;
      const title = 'Space access';
      if (controlled.length === 0) {
        return {
          id: 'space-access',
          status: 'warn',
          title,
          detail: 'No controlled procedures yet',
          fix: 'Mark a procedure controlled from its Confluence byline, or use Load sample data below.',
        };
      }
      const bad: string[] = [];
      for (const p of controlled) if (!(await deps.pageReadable(p.pageId))) bad.push(p.pageId);
      if (bad.length === 0) {
        return { id: 'space-access', status: 'ok', title, detail: `${controlled.length} controlled procedures readable` };
      }
      return { id: 'space-access', status: 'fail', title, detail: `Cannot read page ${bad.join(', ')}`, fix: SPACE_FIX };
    }),
    safe('gate', 'Done gate', async () => {
      const hb = await repos.gateHeartbeat.get();
      const title = 'Done gate';
      if (hb === null) {
        return {
          id: 'gate',
          status: 'warn',
          title,
          detail: 'No Done transition has run the Canon gate yet',
          fix: "Add the 'Canon procedure gate' validator to the Done transition of your workflow (Workflow editor → Done transition → Validators → Add → Canon procedure gate), then try a Done transition.",
        };
      }
      return { id: 'gate', status: 'ok', title, detail: `Canon gate last ran ${hb.at} on ${hb.issueKey}` };
    }),
    safe('policy', 'Policy', async () => {
      const s = await repos.settings.get();
      const detail = `Revision policy ${s.revisionPolicy}; validator mode ${s.validatorMode}; independent approver ${
        s.requireIndependentApprover ? 'on' : 'off'
      }`;
      if (s.validatorMode === 'warn') {
        return { id: 'policy', status: 'warn', title: 'Policy', detail, fix: 'Switch to Block to enforce' };
      }
      return { id: 'policy', status: 'ok', title: 'Policy', detail };
    }),
    safe('auto-bind', 'Auto-bind', async () => {
      const [s, controlled] = await Promise.all([repos.settings.get(), controlledP]);
      const title = 'Auto-bind';
      const entries = Object.entries(s.autoBind);
      if (entries.length === 0) return { id: 'auto-bind', status: 'warn', title, detail: 'No auto-bind mappings' };
      const known = new Set(controlled.map((p) => p.pageId));
      const orphan = entries.filter(([, pageId]) => !known.has(pageId));
      const detail = entries.map(([k, v]) => `${k} → ${v}`).join(', ');
      if (orphan.length > 0) {
        return {
          id: 'auto-bind',
          status: 'warn',
          title,
          detail: `${detail}. Not a controlled procedure: ${orphan.map(([k, v]) => `${k} → ${v}`).join(', ')}`,
          fix: 'Mark that page controlled or change the mapping',
        };
      }
      return { id: 'auto-bind', status: 'ok', title, detail };
    }),
    safe('procedures', 'Procedures', async () => {
      const [controlled, open] = await Promise.all([controlledP, repos.procedures.listWithOpenBindings()]);
      return {
        id: 'procedures',
        status: 'ok',
        title: 'Procedures',
        detail: `${controlled.length} controlled procedures; ${open.length} with open bindings`,
      };
    }),
  ]);
  return { checks };
}
