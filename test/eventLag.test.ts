import { describe, expect, it } from 'vitest';
import { buildPageEventLog } from '../src/domain/eventLag';

const RECEIVED_MS = Date.parse('2026-11-21T10:00:05.000Z');

function updateEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventType: 'avi:confluence:updated:page',
    eventCreatedDate: '2026-11-21T10:00:02.000Z',
    selfGenerated: false,
    updateTrigger: 'page_edit',
    atlassianId: 'abc',
    content: {
      id: '12345',
      title: 'Procedure A',
      version: { number: 7, when: '2026-11-21T10:00:00.000Z' },
    },
    ...overrides,
  };
}

describe('buildPageEventLog', () => {
  it('builds a log for a valid update event', () => {
    expect(buildPageEventLog(updateEvent(), RECEIVED_MS)).toEqual({
      tag: 'canon-event',
      eventType: 'avi:confluence:updated:page',
      pageId: '12345',
      title: 'Procedure A',
      version: 7,
      versionWhen: '2026-11-21T10:00:00.000Z',
      eventCreatedDate: '2026-11-21T10:00:02.000Z',
      receivedAt: '2026-11-21T10:00:05.000Z',
      lagFromVersionMs: 5000,
      lagFromEventMs: 3000,
      updateTrigger: 'page_edit',
    });
  });

  it('returns null for self-generated events', () => {
    expect(buildPageEventLog(updateEvent({ selfGenerated: true }), RECEIVED_MS)).toBeNull();
  });

  it('returns null when the version is missing', () => {
    const event = updateEvent();
    (event.content as Record<string, unknown>).version = undefined;
    expect(buildPageEventLog(event, RECEIVED_MS)).toBeNull();
  });

  it('returns null when required fields are invalid', () => {
    expect(buildPageEventLog(updateEvent({ eventType: '' }), RECEIVED_MS)).toBeNull();
    expect(buildPageEventLog(updateEvent({ content: { version: { number: 1 } } }), RECEIVED_MS)).toBeNull();
    expect(
      buildPageEventLog(
        updateEvent({ content: { id: '1', version: { number: 1.5, when: '2026-11-21T10:00:00.000Z' } } }),
        RECEIVED_MS,
      ),
    ).toBeNull();
    expect(buildPageEventLog(null, RECEIVED_MS)).toBeNull();
    expect(buildPageEventLog('not an event', RECEIVED_MS)).toBeNull();
  });

  it('returns null lags and keeps the log when dates are unparsable', () => {
    const log = buildPageEventLog(
      updateEvent({
        eventCreatedDate: 'not-a-date',
        content: { id: '12345', version: { number: 7, when: 'yesterday' } },
      }),
      RECEIVED_MS,
    );
    expect(log).not.toBeNull();
    expect(log?.lagFromVersionMs).toBeNull();
    expect(log?.lagFromEventMs).toBeNull();
    expect(log?.versionWhen).toBe('yesterday');
    expect(log?.eventCreatedDate).toBe('not-a-date');
  });

  it('handles a created event without an update trigger or title', () => {
    const log = buildPageEventLog(
      {
        eventType: 'avi:confluence:created:page',
        content: { id: '999', version: { number: 1, when: '2026-11-21T09:59:59.500Z' } },
      },
      RECEIVED_MS,
    );
    expect(log).toEqual({
      tag: 'canon-event',
      eventType: 'avi:confluence:created:page',
      pageId: '999',
      title: null,
      version: 1,
      versionWhen: '2026-11-21T09:59:59.500Z',
      eventCreatedDate: null,
      receivedAt: '2026-11-21T10:00:05.000Z',
      lagFromVersionMs: 5500,
      lagFromEventMs: null,
      updateTrigger: null,
    });
  });

  it('computes numeric lags exactly, including negative clock skew', () => {
    const log = buildPageEventLog(
      updateEvent({
        eventCreatedDate: '2026-11-21T10:00:06.250Z',
        content: { id: '12345', version: { number: 2, when: '2026-11-21T10:00:04.750Z' } },
      }),
      RECEIVED_MS,
    );
    expect(log?.lagFromVersionMs).toBe(250);
    expect(log?.lagFromEventMs).toBe(-1250);
  });
});
