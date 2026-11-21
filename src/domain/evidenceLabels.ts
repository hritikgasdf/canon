// Dependency-free display helpers for evidence (safe for the frontend bundle: types only).
import type { AuditEvent } from './types';

const titleCase = (s: string) =>
  s
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** Human label for an actor id. Never returns a raw account id. */
export function actorLabel(id: string, names: Record<string, string> = {}): string {
  if (id.startsWith('sample:')) return `${titleCase(id.slice('sample:'.length))} (sample)`;
  if (id.startsWith('canon:')) {
    const x = id.slice('canon:'.length);
    return `Canon (${x})`;
  }
  return names[id] ?? 'Unknown user';
}

/** Distinct actors that look like Atlassian account ids (not 'sample:' / 'canon:'). */
export function actorIds(audit: Array<Pick<AuditEvent, 'actor'>>): string[] {
  return [...new Set(audit.map((ev) => ev.actor))].filter(
    (a) => a !== '' && !a.startsWith('sample:') && !a.startsWith('canon:'),
  );
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export function eventLabel(
  ev: Pick<AuditEvent, 'type' | 'actor' | 'payload'>,
  names: Record<string, string> = {},
): string {
  const actor = actorLabel(ev.actor, names);
  const p = ev.payload ?? {};
  switch (ev.type) {
    case 'SUPERSEDED': {
      const to = num(p.toVersion);
      const from = num(p.fromVersion);
      const delta = num(p.deltaItems);
      const head = to !== undefined ? `Procedure v${to} approved by ${actor}` : `Procedure approved by ${actor}`;
      const range =
        from !== undefined && to !== undefined
          ? ` (v${from} → v${to}${delta !== undefined ? `, ${delta} material changes` : ''})`
          : '';
      return `${head}; work superseded${range}`;
    }
    case 'BOUND': {
      const v = num(p.version);
      return `Bound${v !== undefined ? ` to v${v}` : ''} by ${actor}`;
    }
    case 'WORK_CLOSED':
      return 'Work closed';
    case 'WORK_REOPENED':
      return 'Work reopened';
    case 'REATTEST_STARTED':
      return `Re-attestation started by ${actor}`;
    case 'ROVO_TASKS_SET': {
      const n = Array.isArray(p.itemIds) ? p.itemIds.length : 0;
      return `Canon agent suggested ${n} tasks (confirmed by ${actor})`;
    }
    case 'ITEM_ATTESTED':
      return `Item ${p.action === 'NOT_MATERIAL' ? 'marked not material' : 'done'} by ${actor}`;
    case 'SIGNED_OFF':
      return `Signed off by ${actor} (independent checker)`;
    case 'EVIDENCE_EXPORTED':
      return `Evidence pack attached by ${actor}`;
    case 'BREAK_GLASS':
      return `Break-glass override by ${actor}`;
    case 'SAMPLE_LOADED':
      return 'Sample data: loaded';
    case 'SAMPLE_RESET':
      return 'Sample data: reset';
    default:
      return `${ev.type} by ${actor}`;
  }
}
