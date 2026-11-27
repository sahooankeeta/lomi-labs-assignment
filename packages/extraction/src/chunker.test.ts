import { describe, expect, it, vi } from 'vitest';
import {
  assertTiling,
  DocumentTooLongError,
  planChunks,
  type PlannedChunk,
  type TokenCounter,
} from './chunker.js';
import { joinPages } from './pages.js';

const fake: TokenCounter = { count: async (t) => Math.ceil(t.length / 4) };

/** Small deterministic PRNG so the "random" cases are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'lease',
  'tenant',
  'rent',
  'the',
  'of',
  'premises',
  'shall',
  'pay',
  '$1,985.00',
  'term',
];

function sentence(r: () => number, words: number): string {
  const ws = Array.from({ length: words }, () => WORDS[Math.floor(r() * WORDS.length)]!);
  return ws.join(' ') + '.';
}

function paragraph(r: () => number, chars: number): string {
  let p = '';
  while (p.length < chars) p += (p ? ' ' : '') + sentence(r, 5 + Math.floor(r() * 10));
  return p;
}

function page(r: () => number, chars: number, paraChars: [number, number]): string {
  const paras: string[] = [];
  let len = 0;
  while (len < chars) {
    const p = paragraph(r, paraChars[0] + Math.floor(r() * (paraChars[1] - paraChars[0])));
    paras.push(p);
    len += p.length + 2;
  }
  return paras.join('\n\n');
}

function slices(text: string, chunks: PlannedChunk[]): string[] {
  return chunks.map((c) => text.slice(c.start, c.end));
}

describe('planChunks', () => {
  it('returns one chunk for short text and counts once', async () => {
    const counter = { count: vi.fn(fake.count) };
    const { text, pageOffsets } = joinPages(['Invoice Number: INV-1', 'Total Due: $5']);
    const plan = await planChunks(text, pageOffsets, counter);
    expect(plan.chunks).toEqual([
      {
        index: 0,
        start: 0,
        end: text.length,
        tokens: Math.ceil(text.length / 4),
        firstPage: 1,
        lastPage: 2,
      },
    ]);
    expect(counter.count).toHaveBeenCalledTimes(1);
  });

  it('cuts at page starts, else blank lines, when one is in budget', async () => {
    const r = rng(1);
    const { text, pageOffsets } = joinPages([0, 1, 2].map(() => page(r, 10_000, [300, 600])));
    const plan = await planChunks(text, pageOffsets, fake, { targetTokens: 1000 });
    assertTiling(plan.chunks, text.length);
    expect(plan.chunks.length).toBeGreaterThan(3);
    const budget = 1000 * plan.charsPerToken;
    let coreStart = 0;
    for (const c of plan.chunks.slice(0, -1)) {
      const pageInWindow = pageOffsets.filter((p) => p > coreStart && p <= coreStart + budget);
      if (pageInWindow.length > 0) expect(c.end).toBe(pageInWindow[pageInWindow.length - 1]);
      else expect(text.slice(c.end - 2, c.end)).toBe('\n\n');
      coreStart = c.end;
    }
  });

  it('tiles random documents and covers every character', async () => {
    for (let run = 0; run < 200; run++) {
      const r = rng(1000 + run);
      const pages = Array.from({ length: 1 + Math.floor(r() * 4) }, () =>
        r() < 0.1 ? '' : page(r, 200 + Math.floor(r() * 3000), [20, 800]),
      );
      const { text, pageOffsets } = joinPages(pages);
      const plan = await planChunks(text, pageOffsets, fake, {
        targetTokens: 50 + Math.floor(r() * 300),
        maxTokens: 400,
        overlapTokens: 30,
        maxChunks: 10_000,
      });
      assertTiling(plan.chunks, text.length);
      const covered = new Uint8Array(text.length);
      for (const c of plan.chunks) covered.fill(1, c.start, c.end);
      expect(covered.every((x) => x === 1)).toBe(true);
    }
  });

  it('falls back to sentence boundaries inside one huge paragraph', async () => {
    const text = paragraph(rng(7), 40_000);
    const plan = await planChunks(text, [0], fake, { targetTokens: 1000, maxTokens: 1500 });
    assertTiling(plan.chunks, text.length);
    expect(plan.chunks.length).toBeGreaterThan(5);
    for (const c of plan.chunks) expect(c.tokens).toBeLessThanOrEqual(1500);
    for (const c of plan.chunks.slice(0, -1)) expect(text.slice(c.end - 2, c.end)).toBe('. ');
  });

  it('re-splits a chunk whose real token count exceeds the max', async () => {
    // Tokens are dense in the second half, so the char-based budget undershoots there.
    const text = paragraph(rng(3), 8_000) + '\n\n' + paragraph(rng(4), 8_000);
    const split = text.indexOf('\n\n') + 2;
    const skewed: TokenCounter = {
      count: async (t) => {
        const at = text.indexOf(t);
        const dense = Math.max(0, at + t.length - Math.max(at, split));
        return Math.ceil((t.length - dense) / 8 + dense / 2);
      },
    };
    const plan = await planChunks(text, [0], skewed, { targetTokens: 1000, maxTokens: 1500 });
    assertTiling(plan.chunks, text.length);
    for (const c of plan.chunks) expect(c.tokens).toBeLessThanOrEqual(1500);
  });

  it('overlaps the previous chunk by its last short paragraph', async () => {
    const { text, pageOffsets } = joinPages([page(rng(5), 12_000, [100, 300])]);
    const plan = await planChunks(text, pageOffsets, fake, { targetTokens: 1000 });
    const [c1, c2] = plan.chunks;
    expect(c2!.start).toBeLessThan(c1!.end);
    expect(c1!.end - c2!.start).toBeLessThanOrEqual(200 * 4);
    expect(text.slice(c2!.start - 2, c2!.start)).toBe('\n\n');
  });

  it('is deterministic', async () => {
    const { text, pageOffsets } = joinPages([
      page(rng(9), 9_000, [50, 700]),
      page(rng(10), 9_000, [50, 700]),
    ]);
    const a = await planChunks(text, pageOffsets, fake, { targetTokens: 700 });
    const b = await planChunks(text, pageOffsets, fake, { targetTokens: 700 });
    expect(b).toEqual(a);
    expect(slices(text, a.chunks)).toEqual(slices(text, b.chunks));
  });

  it('rejects documents with more chunks than the cap', async () => {
    const r = rng(11);
    const { text, pageOffsets } = joinPages([0, 1, 2].map(() => page(r, 3_000, [200, 400])));
    const plan = planChunks(text, pageOffsets, fake, { targetTokens: 1000, maxChunks: 2 });
    await expect(plan).rejects.toBeInstanceOf(DocumentTooLongError);
    await expect(plan).rejects.toThrow('Document too long (3 chunks; limit 2)');
  });
});

describe('assertTiling', () => {
  const chunk = (start: number, end: number, index = 0): PlannedChunk => ({
    index,
    start,
    end,
    tokens: 1,
    firstPage: 1,
    lastPage: 1,
  });

  it('accepts overlapping, complete tilings', () => {
    expect(() => assertTiling([chunk(0, 10), chunk(8, 20, 1)], 20)).not.toThrow();
  });

  it('throws on a gap', () => {
    expect(() => assertTiling([chunk(0, 10), chunk(12, 20, 1)], 20)).toThrow();
  });

  it('throws when the last chunk stops short or the first does not start at 0', () => {
    expect(() => assertTiling([chunk(0, 10)], 20)).toThrow();
    expect(() => assertTiling([chunk(1, 20)], 20)).toThrow();
    expect(() => assertTiling([], 20)).toThrow();
  });
});
