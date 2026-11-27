import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExpectedFields } from './fields.js';

/**
 * The monorepo root. This file runs from `packages/shared/{src,dist}`, so the root is three
 * levels up in both the source (vitest/tsx) and the built output.
 */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

/**
 * Resolves a configured directory (e.g. `UPLOAD_DIR`, `FIXTURES_DIR`) against the repo root.
 * Absolute paths, POSIX (`/data/uploads` in Docker) or Windows (`C:\…`), come back unchanged.
 *
 * Why: `pnpm --filter <pkg> dev` runs each app with its own package as cwd, so a relative
 * `./uploads` from `.env` would point at a different folder for the api, worker and seed.
 * Anchoring at the repo root makes them all share one folder.
 */
export function resolveRepoPath(dir: string, root: string = REPO_ROOT): string {
  // win32.isAbsolute too, so a Windows path is never re-rooted when read on POSIX.
  if (path.isAbsolute(dir) || path.win32.isAbsolute(dir)) return dir;
  return path.resolve(root, dir);
}

/** Node-only: reads fixtures/expected-fields.json. Kept out of the main entry so browsers never import `fs`. */
export function loadExpectedFields(
  dir: string = process.env.FIXTURES_DIR ?? 'fixtures',
): ExpectedFields {
  const file = path.join(resolveRepoPath(dir), 'expected-fields.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read expected fields at ${file}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return ExpectedFields.parse(JSON.parse(raw));
}
