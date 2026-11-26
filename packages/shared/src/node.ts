import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ExpectedFields } from './fields.js';

/** Node-only: reads fixtures/expected-fields.json. Kept out of the main entry so browsers never import `fs`. */
export function loadExpectedFields(
  dir: string = process.env.FIXTURES_DIR ?? 'fixtures',
): ExpectedFields {
  const file = join(resolve(dir), 'expected-fields.json');
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
