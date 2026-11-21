export type PageEventLog = {
  tag: 'canon-event';
  eventType: string;
  pageId: string;
  title: string | null;
  version: number;
  versionWhen: string;
  eventCreatedDate: string | null;
  receivedAt: string;
  lagFromVersionMs: number | null;
  lagFromEventMs: number | null;
  updateTrigger: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function lagMs(receivedAtMs: number, iso: string | null): number | null {
  if (iso === null) {
    return null;
  }
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : receivedAtMs - parsed;
}

/**
 * Builds a timing log entry for a Confluence page event. Returns null for
 * self-generated events or when required fields are missing or invalid.
 */
export function buildPageEventLog(event: unknown, receivedAtMs: number): PageEventLog | null {
  if (!isRecord(event) || event.selfGenerated === true) {
    return null;
  }
  if (!Number.isFinite(receivedAtMs)) {
    return null;
  }

  const eventType = nonEmptyString(event.eventType);
  const content = isRecord(event.content) ? event.content : null;
  const pageId = content ? nonEmptyString(content.id) : null;
  const version = content && isRecord(content.version) ? content.version : null;
  const versionNumber = version ? version.number : undefined;

  if (eventType === null || pageId === null || version === null) {
    return null;
  }
  if (typeof versionNumber !== 'number' || !Number.isInteger(versionNumber) || versionNumber <= 0) {
    return null;
  }

  const versionWhen = nonEmptyString(version.when) ?? '';
  const eventCreatedDate = nonEmptyString(event.eventCreatedDate);

  return {
    tag: 'canon-event',
    eventType,
    pageId,
    title: content ? nonEmptyString(content.title) : null,
    version: versionNumber,
    versionWhen,
    eventCreatedDate,
    receivedAt: new Date(receivedAtMs).toISOString(),
    lagFromVersionMs: lagMs(receivedAtMs, versionWhen || null),
    lagFromEventMs: lagMs(receivedAtMs, eventCreatedDate),
    updateTrigger: nonEmptyString(event.updateTrigger),
  };
}
