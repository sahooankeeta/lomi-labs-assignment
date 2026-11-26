import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadExpectedFields } from './node.js';

const fixturesDir = fileURLToPath(new URL('../../../fixtures', import.meta.url));

describe('loadExpectedFields', () => {
  it('loads and parses the repo fixtures', () => {
    const fields = loadExpectedFields(fixturesDir);
    expect(fields.invoice).toHaveLength(5);
    expect(fields.invoice?.find((f) => f.field === 'total_amount')?.type).toBe('money');
  });

  it('names the path when expected-fields.json is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lomi-shared-'));
    expect(() => loadExpectedFields(dir)).toThrow(dir);
  });
});
