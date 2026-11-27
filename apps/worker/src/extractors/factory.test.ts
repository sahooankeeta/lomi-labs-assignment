import { describe, expect, it } from 'vitest';
import { FakeExtractor, GeminiExtractor, MissingKeyExtractor, createExtractor } from './index.js';

const req = {
  type: 'invoice' as const,
  fields: [],
  chunkText: '',
  prompt: { system: '', user: '' },
};

describe('createExtractor', () => {
  it('EXTRACTOR=fake gives the fake extractor (even with a key)', () => {
    expect(createExtractor({ EXTRACTOR: 'fake', GEMINI_API_KEY: 'x' })).toBeInstanceOf(
      FakeExtractor,
    );
  });

  it('no key gives MissingKeyExtractor whose calls reject with a clear message', async () => {
    const ex = createExtractor({});
    expect(ex).toBeInstanceOf(MissingKeyExtractor);
    await expect(ex.extract(req)).rejects.toThrow(/^GEMINI_API_KEY is not set$/);
    await expect(ex.countTokens('x')).rejects.toThrow(/^GEMINI_API_KEY is not set$/);
  });

  it('a blank key counts as missing', () => {
    expect(createExtractor({ GEMINI_API_KEY: '  ' })).toBeInstanceOf(MissingKeyExtractor);
    expect(createExtractor({ EXTRACTOR: '', GEMINI_API_KEY: '' })).toBeInstanceOf(
      MissingKeyExtractor,
    );
  });

  it('unset EXTRACTOR with a key gives GeminiExtractor with the default model', () => {
    const ex = createExtractor({ GEMINI_API_KEY: 'x' });
    expect(ex).toBeInstanceOf(GeminiExtractor);
    expect(ex.model).toBe('gemini-3.6-flash');
  });

  it('EXTRACTOR=gemini without a key rejects with GEMINI_API_KEY is not set', async () => {
    const ex = createExtractor({ EXTRACTOR: 'gemini' });
    expect(ex).toBeInstanceOf(MissingKeyExtractor);
    await expect(ex.extract(req)).rejects.toThrow(/^GEMINI_API_KEY is not set$/);
  });

  it('EXTRACTOR=gemini with a key gives GeminiExtractor with the default model', () => {
    const ex = createExtractor({ EXTRACTOR: 'gemini', GEMINI_API_KEY: 'k' });
    expect(ex).toBeInstanceOf(GeminiExtractor);
    expect(ex.model).toBe('gemini-3.6-flash');
  });

  it('honours GEMINI_MODEL and GEMINI_FALLBACK_MODELS', () => {
    const ex = createExtractor({
      EXTRACTOR: 'gemini',
      GEMINI_API_KEY: 'k',
      GEMINI_MODEL: 'm-1',
      GEMINI_FALLBACK_MODELS: 'a, ,b,m-1',
    });
    expect(ex.model).toBe('m-1');
    expect((ex as GeminiExtractor).models).toEqual(['m-1', 'a', 'b']);
  });

  it('an unsupported EXTRACTOR value gives a clear MissingKeyExtractor', async () => {
    const ex = createExtractor({ EXTRACTOR: 'bogus', GEMINI_API_KEY: 'x' });
    await expect(ex.extract(req)).rejects.toThrow(
      'EXTRACTOR=bogus is not supported (use gemini or fake)',
    );
  });

  it('EXTRACTOR=claude is not supported', async () => {
    const ex = createExtractor({ EXTRACTOR: 'claude', GEMINI_API_KEY: 'x' });
    await expect(ex.extract(req)).rejects.toThrow(
      'EXTRACTOR=claude is not supported (use gemini or fake)',
    );
  });
});
