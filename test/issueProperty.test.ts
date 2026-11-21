import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestJira } = vi.hoisted(() => ({ requestJira: vi.fn() }));

vi.mock('@forge/api', () => ({
  default: { asApp: () => ({ requestJira }) },
  route: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), ''),
}));

import { putCanonGateProperty } from '../src/forge/issueProperty';
import type { IssueSummary } from '../src/domain/issueSummary';

const summary: IssueSummary = {
  state: 'SUPERSEDED',
  bindingCount: 2,
  boundVersion: 1,
  targetVersion: 3,
  pageIds: ['P1', 'P2'],
};

describe('putCanonGateProperty', () => {
  beforeEach(() => {
    requestJira.mockReset();
  });

  it('PUTs the canon.gate property on the issue', async () => {
    requestJira.mockResolvedValue({ ok: true, status: 200 });

    await putCanonGateProperty('CHG-1', summary);

    expect(requestJira).toHaveBeenCalledTimes(1);
    const [path, init] = requestJira.mock.calls[0] as [string, { method: string }];
    expect(path).toBe('/rest/api/3/issue/CHG-1/properties/canon.gate');
    expect(init.method).toBe('PUT');
  });

  it('sends only the JQL fields plus updatedAt, never pageIds', async () => {
    requestJira.mockResolvedValue({ ok: true, status: 200 });

    await putCanonGateProperty('CHG-1', summary);

    const [, init] = requestJira.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['bindingCount', 'boundVersion', 'state', 'targetVersion', 'updatedAt']);
    expect(body).not.toHaveProperty('pageIds');
    expect(init.body).not.toContain('P1');
    expect(body).toMatchObject({ state: 'SUPERSEDED', bindingCount: 2, boundVersion: 1, targetVersion: 3 });
    expect(typeof body.updatedAt).toBe('string');
  });

  it('throws with the HTTP status in the message on a non-2xx response', async () => {
    requestJira.mockResolvedValue({ ok: false, status: 403 });

    await expect(putCanonGateProperty('CHG-1', summary)).rejects.toThrow(/403/);
  });
});
