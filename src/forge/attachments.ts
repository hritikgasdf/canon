// Forge adapter: attach files to a Jira issue as the app.
import api, { route } from '@forge/api';
import type { EvidenceFile } from './evidenceResolver';

export async function uploadAttachments(issueKey: string, files: EvidenceFile[]): Promise<void> {
  const form = new FormData();
  for (const f of files) form.append('file', new Blob([f.content], { type: f.type }), f.name);
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/attachments`, {
    method: 'POST',
    headers: { 'X-Atlassian-Token': 'no-check' },
    // @forge/api types omit FormData, but the runtime accepts it for multipart uploads.
    body: form as unknown as string,
  });
  if (!res.ok) throw new Error(`Attachment upload failed (${res.status})`);
}
