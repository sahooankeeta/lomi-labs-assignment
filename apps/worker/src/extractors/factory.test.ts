import { describe, expect, it } from 'vitest';
import { ClaudeExtractor, FakeExtractor, MissingKeyExtractor, createExtractor } from './index.js';

describe('createExtractor', () => {
  it('EXTRACTOR=fake gives the fake extractor (even with a key)', () => {
    expect(createExtractor({ EXTRACTOR: 'fake', ANTHROPIC_API_KEY: 'x' })).toBeInstanceOf(
      FakeExtractor,
    );
  });

  it('no key gives MissingKeyExtractor whose calls reject with a clear message', async () => {
    const ex = createExtractor({});
    expect(ex).toBeInstanceOf(MissingKeyExtractor);
    const req = {
      type: 'invoice' as const,
      fields: [],
      chunkText: '',
      prompt: { system: '', user: '' },
    };
    await expect(ex.extract(req)).rejects.toThrow(/^ANTHROPIC_API_KEY is not set$/);
    await expect(ex.countTokens('x')).rejects.toThrow(/^ANTHROPIC_API_KEY is not set$/);
  });

  it('a blank key counts as missing', () => {
    expect(createExtractor({ ANTHROPIC_API_KEY: '  ' })).toBeInstanceOf(MissingKeyExtractor);
  });

  it('a key gives ClaudeExtractor with the default model', () => {
    const ex = createExtractor({ ANTHROPIC_API_KEY: 'x' });
    expect(ex).toBeInstanceOf(ClaudeExtractor);
    expect(ex.model).toBe('claude-sonnet-5-5');
  });

  it('honours ANTHROPIC_MODEL', () => {
    expect(createExtractor({ ANTHROPIC_API_KEY: 'x', ANTHROPIC_MODEL: 'm-1' }).model).toBe('m-1');
  });
});
