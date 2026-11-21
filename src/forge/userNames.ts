// Forge adapter: best-effort accountId → displayName lookup as the app.
import api, { route } from '@forge/api';

const DISPLAY_NAME_CAP = 20;

/** Best effort accountId → displayName as the app (per-id lookups, so route`` escapes each id). */
export async function displayNames(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    ids.slice(0, DISPLAY_NAME_CAP).map(async (id) => {
      try {
        const res = await api.asApp().requestJira(route`/rest/api/3/user?accountId=${id}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return;
        const name = ((await res.json()) as { displayName?: unknown }).displayName;
        if (typeof name === 'string' && name !== '') out[id] = name;
      } catch {
        // best effort
      }
    }),
  );
  return out;
}
