import { describe, expect, it, vi } from 'vitest';
import { visibleIssuesWith } from '../src/forge/visibility';

describe('visibleIssuesWith', () => {
  it('uses one search per chunk and keeps only requested keys', async () => {
    const search = vi.fn(async (chunk: string[]) => [...chunk.slice(0, 1), 'OTHER-9']);
    const getOne = vi.fn(async () => true);
    const r = await visibleIssuesWith(['CHG-1', 'CHG-2'], { search, getOne });
    expect([...r]).toEqual(['CHG-1']);
    expect(search).toHaveBeenCalledTimes(1);
    expect(getOne).not.toHaveBeenCalled();
  });

  it('drops invalid keys before building any query', async () => {
    const search = vi.fn(async (chunk: string[]) => chunk);
    await visibleIssuesWith(['CHG-1', 'x) OR project = SECRET', 'chg-2'], { search, getOne: async () => true });
    expect(search).toHaveBeenCalledWith(['CHG-1']);
  });

  it('falls back to per-issue GETs when the search fails or throws', async () => {
    for (const search of [async () => null, async () => Promise.reject(new Error('400'))]) {
      const getOne = vi.fn(async (k: string) => k !== 'CHG-2');
      const r = await visibleIssuesWith(['CHG-1', 'CHG-2', 'CHG-3'], { search, getOne });
      expect([...r].sort()).toEqual(['CHG-1', 'CHG-3']);
      expect(getOne).toHaveBeenCalledTimes(3);
    }
  });

  it('a throwing per-issue GET hides that issue only', async () => {
    const r = await visibleIssuesWith(['CHG-1', 'CHG-2'], {
      search: async () => null,
      getOne: async (k) => {
        if (k === 'CHG-1') throw new Error('boom');
        return true;
      },
    });
    expect([...r]).toEqual(['CHG-2']);
  });

  it('chunks 250 keys into 3 searches', async () => {
    const keys = Array.from({ length: 250 }, (_, i) => `CHG-${i + 1}`);
    const search = vi.fn(async (chunk: string[]) => chunk);
    const r = await visibleIssuesWith(keys, { search, getOne: async () => false });
    expect(search).toHaveBeenCalledTimes(3);
    expect(r.size).toBe(250);
  });
});
