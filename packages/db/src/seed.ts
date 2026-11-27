import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@lomi/logger';
import { FixtureManifest } from '@lomi/shared';
import { resolveRepoPath } from '@lomi/shared/node';
import { createDb } from './client.js';
import { createDocumentWithV1 } from './documents.js';

/**
 * Seeds version 1 of each fixture document. Safe to run on every boot: a document
 * of the same type whose v1 has the same sha256 already exists → skipped (the same
 * rule the API uses for double uploads). Versions start `queued`; the worker finds
 * them in Postgres, so seeding never depends on Redis.
 */
// Same repo-root rule as the api and worker, so all three share one uploads folder.
const fixturesDir = resolveRepoPath(process.env.FIXTURES_DIR ?? 'fixtures');
const uploadDir = resolveRepoPath(process.env.UPLOAD_DIR ?? 'uploads');

const manifest = FixtureManifest.parse(
  JSON.parse(await readFile(path.join(fixturesDir, 'documents.json'), 'utf8')),
);

const log = createLogger('seed');
const prisma = createDb();
await mkdir(uploadDir, { recursive: true });

try {
  for (const doc of manifest) {
    const v1 = doc.versions.find((v) => v.version === 1);
    if (!v1) continue;

    const src = path.join(fixturesDir, v1.file);
    const sha256 = createHash('sha256')
      .update(await readFile(src))
      .digest('hex');
    const fileKey = `${sha256}.pdf`;
    // File first, then the row: a crash in between leaves a harmless orphan file.
    await copyFile(src, path.join(uploadDir, fileKey));

    const result = await createDocumentWithV1(prisma, {
      type: doc.type,
      title: doc.title,
      fileKey,
      sha256,
    });
    if (!result.created) {
      log.info({ title: doc.title, type: doc.type }, 'v1 already present, skipped');
      continue;
    }
    log.info({ title: doc.title, type: doc.type, sha256 }, 'seeded v1 (queued)');
  }
} finally {
  await prisma.$disconnect();
}
