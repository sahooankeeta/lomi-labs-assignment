import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { TEST_DATABASE_URL, truncateAll } from './testing.js';

let db: Db;
beforeAll(() => {
  db = createDb(TEST_DATABASE_URL);
});
afterAll(async () => {
  await truncateAll(db);
  await db.$disconnect();
});

describe('test database harness', () => {
  it('migrates, inserts, and truncates', async () => {
    await db.document.create({ data: { type: 'invoice', title: 'Harness check' } });
    expect(await db.document.count()).toBe(1);
    await truncateAll(db);
    expect(await db.document.count()).toBe(0);
  });
});
