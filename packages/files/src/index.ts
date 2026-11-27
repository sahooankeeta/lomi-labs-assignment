import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface FileStore {
  put(bytes: Uint8Array): Promise<{ key: string; sha256: string }>;
  read(key: string): Promise<Uint8Array>;
  stream(key: string): NodeJS.ReadableStream;
}

const KEY_PATTERN = /^[0-9a-f]{64}\.pdf$/;

/** Content-addressed store on a local directory: key = `<sha256>.pdf`. */
export class LocalFileStore implements FileStore {
  constructor(private readonly dir: string) {}

  async put(bytes: Uint8Array): Promise<{ key: string; sha256: string }> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = `${sha256}.pdf`;
    await mkdir(this.dir, { recursive: true });
    const target = join(this.dir, key);
    if (await exists(target)) return { key, sha256 };
    // Write beside the target, then rename: readers never see a partial file.
    const tmp = join(this.dir, `.${key}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, bytes);
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      // A concurrent put of the same bytes may have won; content-addressed, so that is success.
      if (!(await exists(target))) throw err;
    }
    return { key, sha256 };
  }

  read(key: string): Promise<Uint8Array> {
    try {
      return readFile(this.pathFor(key));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  stream(key: string): NodeJS.ReadableStream {
    return createReadStream(this.pathFor(key));
  }

  private pathFor(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid file key: ${key}`);
    return join(this.dir, key);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
