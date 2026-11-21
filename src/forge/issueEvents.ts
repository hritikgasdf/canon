import { handleIssueUpdated } from '../domain/autoBind';
import { createAppRepos } from './kvsRepos';

export async function onIssueUpdated(event: unknown): Promise<void> {
  try {
    const result = await handleIssueUpdated(createAppRepos(), event, () => new Date().toISOString());
    console.log(JSON.stringify({ tag: 'canon-autobind', ...result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`canon: issue auto-bind failed: ${message}`);
  }
}
