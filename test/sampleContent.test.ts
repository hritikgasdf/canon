import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SAMPLE_V2_XHTML, SAMPLE_V3_XHTML, SAMPLE_V4_XHTML } from '../src/domain/sampleContent';

describe('sample content mirrors the seed fixtures', () => {
  it.each([
    ['v2', SAMPLE_V2_XHTML],
    ['v3', SAMPLE_V3_XHTML],
    ['v4', SAMPLE_V4_XHTML],
  ])('%s', (v, s) => expect(s).toBe(readFileSync(`seed/sop-pay-014/${v}.xhtml`, 'utf8')));
});
