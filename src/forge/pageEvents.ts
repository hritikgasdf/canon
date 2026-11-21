import { buildPageEventLog } from '../domain/eventLag';
import { handlePageEvent } from '../domain/pageEvent';
import { createAppRepos } from './kvsRepos';
import { fetchBody, getPageMeta } from './confluence';

export async function onPageEvent(event: unknown): Promise<void> {
  try {
    const log = buildPageEventLog(event, Date.now());
    if (log !== null) {
      console.log(JSON.stringify(log));
    } else {
      // Spike diagnostics: record that an event arrived even if it was filtered/unparsed.
      const e = (event ?? {}) as Record<string, unknown>;
      const content = (e.content ?? {}) as Record<string, unknown>;
      console.log(JSON.stringify({ tag: 'canon-event-skipped', receivedAt: new Date().toISOString(), eventType: e.eventType, selfGenerated: e.selfGenerated, contentKeys: Object.keys(content), version: content.version }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`canon: page event logging failed: ${message}`);
  }

  try {
    const result = await handlePageEvent(
      createAppRepos(),
      { getPageMeta, fetchBody, now: () => new Date().toISOString() },
      event,
    );
    console.log(JSON.stringify({ tag: 'canon-page-result', ...result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`canon: page event handling failed: ${message}`);
  }
}
