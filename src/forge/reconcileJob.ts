import { reconcile } from '../domain/reconcile';
import { createAppRepos } from './kvsRepos';
import { fetchBody, getPageMeta } from './confluence';

export async function runReconcile(): Promise<void> {
  try {
    const out = await reconcile(createAppRepos(), {
      getPageMeta,
      fetchBody,
      now: () => new Date().toISOString(),
    });
    console.log(JSON.stringify({ tag: 'canon-reconcile', checked: out.checked, results: out.results }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ tag: 'canon-reconcile', error: message }));
  }
}
