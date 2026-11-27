import { describe, expect, it } from 'vitest';
import {
  ClaudeExtractor,
  FakeExtractor,
  GeminiExtractor,
  MissingKeyExtractor,
  createExtractor,
} from './index.js';

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

  const req = {
    type: 'invoice' as const,
    fields: [],
    chunkText: '',
    prompt: { system: '', user: '' },
  };

  it('EXTRACTOR=gemini without a key rejects with GEMINI_API_KEY is not set', async () => {
    const ex = createExtractor({ EXTRACTOR: 'gemini', ANTHROPIC_API_KEY: 'x' });
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
    const ex = createExtractor({ EXTRACTOR: 'bogus', ANTHROPIC_API_KEY: 'x' });
    await expect(ex.extract(req)).rejects.toThrow(
      'EXTRACTOR=bogus is not supported (use claude, gemini or fake)',
    );
  });

  it('EXTRACTOR=claude behaves like unset', () => {
    expect(createExtractor({ EXTRACTOR: 'claude', ANTHROPIC_API_KEY: 'x' })).toBeInstanceOf(
      ClaudeExtractor,
    );
  });
});
