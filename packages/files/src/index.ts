import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface FileStore {
  put(bytes: Uint8Array): Promise<{ key: string; sha256: string }>;
  read(key: string): Promise<Uint8Array>;
  stream(key: string): NodeJS.ReadableStream;
}

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
    const tmp = join(this.dir, `.${key}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp, bytes);
    await rename(tmp, target);
    return { key, sha256 };
  }

  read(key: string): Promise<Uint8Array> {
    return readFile(join(this.dir, key));
  }

  stream(key: string): NodeJS.ReadableStream {
    return createReadStream(join(this.dir, key));
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
