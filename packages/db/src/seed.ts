import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureManifest } from '@lomi/shared';
import { createDb } from './client.js';

/**
 * Seeds version 1 of each fixture document. Safe to run on every boot: a document
 * of the same type whose v1 has the same sha256 already exists → skipped (the same
 * rule the API uses for double uploads). Versions start `queued`; the worker finds
 * them in Postgres, so seeding never depends on Redis.
 */
const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const fixturesDir = path.resolve(repoRoot, process.env.FIXTURES_DIR ?? 'fixtures');
const uploadDir = path.resolve(repoRoot, process.env.UPLOAD_DIR ?? 'uploads');

const manifest = FixtureManifest.parse(
  JSON.parse(await readFile(path.join(fixturesDir, 'documents.json'), 'utf8')),
);

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

    const existing = await prisma.documentVersion.findFirst({
      where: { versionNo: 1, sha256, document: { type: doc.type } },
      select: { id: true },
    });
    if (existing) {
      console.log(`${doc.title}: v1 already present`);
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const created = await tx.document.create({ data: { type: doc.type, title: doc.title } });
      const version = await tx.documentVersion.create({
        data: { documentId: created.id, versionNo: 1, fileKey, sha256 },
      });
      await tx.document.update({
        where: { id: created.id },
        data: { currentVersionId: version.id },
      });
    });
    console.log(`${doc.title}: seeded v1`);
  }
} finally {
  await prisma.$disconnect();
}
