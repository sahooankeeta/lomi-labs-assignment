import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadExpectedFields, REPO_ROOT, resolveRepoPath } from './node.js';

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

describe('resolveRepoPath', () => {
  it('resolves a relative path against the repo root, not the cwd', () => {
    expect(resolveRepoPath('./uploads', '/repo')).toBe(resolve('/repo', 'uploads'));
    expect(resolveRepoPath('fixtures')).toBe(resolve(REPO_ROOT, 'fixtures'));
  });

  it('finds the real repo root (the folder holding fixtures/)', () => {
    expect(resolveRepoPath('fixtures')).toBe(resolve(fixturesDir));
  });

  it('leaves a POSIX absolute path unchanged', () => {
    expect(resolveRepoPath('/data/uploads', '/repo')).toBe('/data/uploads');
  });

  it('leaves a Windows absolute path unchanged', () => {
    expect(resolveRepoPath('C:\\lomi\\uploads', '/repo')).toBe('C:\\lomi\\uploads');
    expect(resolveRepoPath('D:/lomi/fixtures', '/repo')).toBe('D:/lomi/fixtures');
  });
});
