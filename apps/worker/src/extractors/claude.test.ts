import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeExtractor } from './claude.js';
import type { ExtractRequest } from './types.js';

const OUTPUT = { fields: [{ field: 'a', value: '1', evidence: 'a: 1', gap_reason: null }] };

const req: ExtractRequest = {
  type: 'invoice',
  fields: [{ field: 'a', type: 'string' }],
  chunkText: 'a: 1',
  prompt: { system: 'SYS', user: 'USR' },
};

/** A stub of the two SDK methods the extractor uses; no network. */
function stubClient(over: { parse?: unknown; countTokens?: unknown } = {}) {
  const parse = vi.fn(
    (over.parse as (...a: unknown[]) => unknown) ??
      (async () => ({ stop_reason: 'end_turn', parsed_output: OUTPUT })),
  );
  const countTokens = vi.fn(
    (over.countTokens as (...a: unknown[]) => unknown) ?? (async () => ({ input_tokens: 42 })),
  );
  const client = { messages: { parse, countTokens } } as unknown as Pick<Anthropic, 'messages'>;
  return { client, parse, countTokens };
}

const make = (client: Pick<Anthropic, 'messages'>, maxInflight?: number) =>
  new ClaudeExtractor({ apiKey: 'k', model: 'm-1', client, maxInflight });

describe('ClaudeExtractor.extract', () => {
  it('sends a schema-constrained request, passes the signal and returns output and raw', async () => {
    const { client, parse } = stubClient();
    const signal = new AbortController().signal;
    const res = await make(client).extract(req, { signal });

    expect(res.output).toEqual(OUTPUT);
    expect(res.raw).toMatchObject({ stop_reason: 'end_turn' });
    expect(parse).toHaveBeenCalledTimes(1);
    const [body, options] = parse.mock.calls[0] as [Record<string, unknown>, { signal: unknown }];
    expect(body).toMatchObject({
      model: 'm-1',
      max_tokens: 4096,
      system: 'SYS',
      messages: [{ role: 'user', content: 'USR' }],
    });
    expect(body.output_config).toHaveProperty('format');
    expect(body).not.toHaveProperty('tool_choice');
    expect(options.signal).toBe(signal);
  });

  it.each([
    ['refusal', { stop_reason: 'refusal', parsed_output: null }],
    ['max_tokens', { stop_reason: 'max_tokens', parsed_output: OUTPUT }],
    ['end_turn', { stop_reason: 'end_turn', parsed_output: null }],
  ])('rejects an unusable response (%s)', async (stop, response) => {
    const { client } = stubClient({ parse: async () => response });
    await expect(make(client).extract(req)).rejects.toThrow(
      `model response unusable (stop_reason: ${stop})`,
    );
  });

  it('propagates API errors', async () => {
    const { client } = stubClient({
      parse: async () => {
        throw new Error('429');
      },
    });
    await expect(make(client).extract(req)).rejects.toThrow('429');
  });
});

describe('ClaudeExtractor.countTokens', () => {
  it('returns input_tokens for the model and text', async () => {
    const { client, countTokens } = stubClient();
    await expect(make(client).countTokens('hello')).resolves.toBe(42);
    expect(countTokens).toHaveBeenCalledWith({
      model: 'm-1',
      messages: [{ role: 'user', content: 'hello' }],
    });
  });
});

describe('ClaudeExtractor concurrency', () => {
  it('bounds in-flight calls across extract and countTokens', async () => {
    let active = 0;
    let maxSeen = 0;
    const slow =
      <T>(value: T) =>
      async () => {
        active++;
        maxSeen = Math.max(maxSeen, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return value;
      };
    const { client } = stubClient({
      parse: slow({ stop_reason: 'end_turn', parsed_output: OUTPUT }),
      countTokens: slow({ input_tokens: 1 }),
    });
    const ex = make(client, 2);
    await Promise.all([
      ex.extract(req),
      ex.extract(req),
      ex.extract(req),
      ex.countTokens('a'),
      ex.countTokens('b'),
    ]);
    expect(maxSeen).toBe(2);
  });
});
