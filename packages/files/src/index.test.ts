import { createHash } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalFileStore } from './index.js';

let dir: string;
let store: LocalFileStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lomi-files-'));
  store = new LocalFileStore(dir);
});

const bytes = new TextEncoder().encode('%PDF-1.4 hello');

describe('LocalFileStore', () => {
  it('stores content under its sha256', async () => {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(await store.put(bytes)).toEqual({ key: `${sha256}.pdf`, sha256 });
  });

  it('is idempotent for identical bytes', async () => {
    const a = await store.put(bytes);
    const b = await store.put(bytes);
    expect(b).toEqual(a);
    expect(await readdir(dir)).toEqual([a.key]);
  });

  it('survives concurrent puts of the same bytes', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => store.put(bytes)));
    expect(new Set(results.map((r) => r.key)).size).toBe(1);
    expect(await readdir(dir)).toEqual([results[0]!.key]);
  });

  it('round-trips bytes', async () => {
    const { key } = await store.put(bytes);
    expect(Buffer.from(await store.read(key))).toEqual(Buffer.from(bytes));
  });

  it('streams bytes', async () => {
    const { key } = await store.put(bytes);
    const chunks: Buffer[] = [];
    for await (const c of store.stream(key)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
  });

  it('rejects reading a missing key', async () => {
    await expect(store.read(`${'0'.repeat(64)}.pdf`)).rejects.toThrow();
  });

  it('rejects keys that are not a sha256 pdf name', async () => {
    await expect(store.read('../x.pdf')).rejects.toThrow('Invalid file key');
    expect(() => store.stream('missing.pdf')).toThrow('Invalid file key');
  });
});
