import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ExpectedFields, FixtureManifest } from './fields.js';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)), 'utf8'),
  );

describe('fixture schemas', () => {
  it('parses expected-fields.json', () => {
    const parsed = ExpectedFields.parse(fixture('expected-fields.json'));
    expect(Object.keys(parsed).sort()).toEqual(['invoice', 'lease', 'market_report']);
  });

  it('parses documents.json', () => {
    expect(FixtureManifest.parse(fixture('documents.json'))).toHaveLength(3);
  });
});
