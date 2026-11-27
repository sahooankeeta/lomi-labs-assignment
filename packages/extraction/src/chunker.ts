import { pageOf } from './pages.js';

/**
 * Token-counted chunk planner. Cores tile the text with no gaps; each chunk may also
 * reach back over the previous core's last short paragraph so a fact split across a
 * cut is still seen whole by one call.
 */

export interface TokenCounter {
  count(text: string): Promise<number>;
}

export const CHUNK_DEFAULTS = {
  targetTokens: 6000,
  maxTokens: 8000,
  overlapTokens: 200,
  maxChunks: 50,
} as const;

export type ChunkOptions = { [K in keyof typeof CHUNK_DEFAULTS]: number };

/** Chunk text is `text.slice(start, end)`; `start` may reach back into the previous chunk. */
export interface PlannedChunk {
  index: number;
  start: number;
  end: number;
  tokens: number;
  firstPage: number;
  lastPage: number;
}

export interface ChunkPlan {
  chunks: PlannedChunk[];
  totalTokens: number;
  charsPerToken: number;
}

export class DocumentTooLongError extends Error {
  constructor(
    public readonly chunkCount: number,
    public readonly limit: number = CHUNK_DEFAULTS.maxChunks,
  ) {
    super(`Document too long (${chunkCount} chunks; limit ${limit})`);
    this.name = 'DocumentTooLongError';
  }
}

const enum Strength {
  Word = 0,
  Sentence = 1,
  Line = 2,
  Blank = 3,
  Heading = 4,
  Page = 5,
}

interface Boundary {
  pos: number; // cut before this offset
  strength: Strength;
}

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/u.test(ch);

function isHeadingLine(text: string, lineStart: number): boolean {
  const nl = text.indexOf('\n', lineStart);
  const lineEnd = nl < 0 ? text.length : nl;
  if (lineEnd - lineStart > 80) return false;
  const line = text.slice(lineStart, lineEnd).trim();
  if (line === '' || /[.,;:]$/u.test(line)) return false;
  const allCaps = /\p{L}/u.test(line) && line === line.toUpperCase();
  const numbered = /^\d+[.)]/u.test(line);
  const blankAfter = nl >= 0 && /^\n[^\S\n]*\n/u.test(text.slice(nl, nl + 82));
  return allCaps || numbered || blankAfter;
}

/** Every legal cut position (a word start or page start), sorted, with its strength. */
function findBoundaries(text: string, pageOffsets: number[]): Boundary[] {
  const strengths = new Map<number, Strength>();
  let i = 0;
  while (i < text.length) {
    if (!isSpace(text[i])) {
      i++;
      continue;
    }
    const runStart = i;
    let newlines = 0;
    while (i < text.length && isSpace(text[i])) {
      if (text[i] === '\n') newlines++;
      i++;
    }
    if (runStart === 0 || i >= text.length) continue;
    let s: Strength = /[.!?]/u.test(text[runStart - 1]!) ? Strength.Sentence : Strength.Word;
    if (newlines >= 1) s = Strength.Line;
    if (newlines >= 2) s = Strength.Blank;
    if (newlines >= 1 && isHeadingLine(text, i)) s = Strength.Heading;
    strengths.set(i, s);
  }
  for (const p of pageOffsets) {
    if (p > 0 && p < text.length) strengths.set(p, Strength.Page);
  }
  return [...strengths.entries()]
    .map(([pos, strength]) => ({ pos, strength }))
    .sort((a, b) => a.pos - b.pos);
}

/** Index of the first boundary with `pos > offset`. */
function firstAfter(bounds: Boundary[], offset: number): number {
  let lo = 0;
  let hi = bounds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bounds[mid]!.pos <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Core {
  start: number;
  end: number;
  budget: number;
}

/** Greedy cores over `[from, to)`: strongest boundary in budget, latest among equals. */
function splitCores(bounds: Boundary[], from: number, to: number, budget: number): Core[] {
  const cores: Core[] = [];
  let start = from;
  while (start < to) {
    let end = to;
    if (to - start > budget) {
      const limit = start + budget;
      let best: Boundary | undefined;
      for (let k = firstAfter(bounds, start); k < bounds.length; k++) {
        const b = bounds[k]!;
        if (b.pos >= to) break;
        if (b.pos > limit) {
          best ??= b; // nothing in budget: one oversized unit up to the next legal cut
          break;
        }
        if (!best || b.strength >= best.strength) best = b;
      }
      if (best) end = best.pos;
    }
    cores.push({ start, end, budget });
    start = end;
  }
  return cores;
}

/** Start of the last paragraph of `[coreStart, coreEnd)` if it's short enough to repeat. */
function overlapStart(bounds: Boundary[], prev: Core, maxChars: number): number {
  for (let k = firstAfter(bounds, prev.end - 1) - 1; k >= 0; k--) {
    const b = bounds[k]!;
    if (b.pos <= prev.start) break;
    if (b.strength >= Strength.Blank) return prev.end - b.pos <= maxChars ? b.pos : prev.end;
  }
  return prev.end;
}

export function assertTiling(chunks: PlannedChunk[], length: number): void {
  const fail = (why: string): never => {
    throw new Error(`chunk plan does not tile the text: ${why}`);
  };
  if (chunks.length === 0) fail('no chunks');
  if (chunks[0]!.start !== 0) fail(`first chunk starts at ${chunks[0]!.start}`);
  if (chunks[chunks.length - 1]!.end !== length) {
    fail(`last chunk ends at ${chunks[chunks.length - 1]!.end}, text length ${length}`);
  }
  chunks.forEach((c, i) => {
    if (c.index !== i) fail(`chunk ${i} has index ${c.index}`);
    if (length > 0 && c.start >= c.end) fail(`chunk ${i} is empty`);
    if (i === 0) return;
    const prev = chunks[i - 1]!;
    if (c.end <= prev.end) fail(`chunk ${i} end ${c.end} <= previous end ${prev.end}`);
    if (c.start > prev.end) fail(`gap between chunk ${i - 1} and ${i}`);
    if (c.start < prev.start) fail(`chunk ${i} starts before chunk ${i - 1}`);
  });
}

const MAX_RESPLIT_ROUNDS = 12;

export async function planChunks(
  text: string,
  pageOffsets: number[],
  counter: TokenCounter,
  opts: Partial<ChunkOptions> = {},
): Promise<ChunkPlan> {
  const o: ChunkOptions = { ...CHUNK_DEFAULTS, ...opts };
  const totalTokens = await counter.count(text);
  const charsPerToken = totalTokens > 0 ? text.length / totalTokens : 1;
  const chunkAt = (index: number, start: number, end: number, tokens: number): PlannedChunk => ({
    index,
    start,
    end,
    tokens,
    firstPage: pageOf(start, pageOffsets),
    lastPage: pageOf(Math.max(start, end - 1), pageOffsets),
  });

  if (totalTokens <= o.targetTokens) {
    return { chunks: [chunkAt(0, 0, text.length, totalTokens)], totalTokens, charsPerToken };
  }

  const bounds = findBoundaries(text, pageOffsets);
  const overlapChars = o.overlapTokens * charsPerToken;
  const tooLong = (n: number): void => {
    if (n > o.maxChunks) throw new DocumentTooLongError(n, o.maxChunks);
  };
  const counts = new Map<string, number>();
  const countSpan = async (start: number, end: number): Promise<number> => {
    const key = `${start}:${end}`;
    let n = counts.get(key);
    if (n === undefined) {
      n = await counter.count(text.slice(start, end));
      counts.set(key, n);
    }
    return n;
  };

  let cores = splitCores(
    bounds,
    0,
    text.length,
    Math.max(1, Math.floor(o.targetTokens * charsPerToken)),
  );
  let chunks: PlannedChunk[] = [];
  for (let round = 0; ; round++) {
    tooLong(cores.length); // before counting: don't spend 50+ count calls on a doomed document
    chunks = [];
    for (const [i, core] of cores.entries()) {
      const start = i === 0 ? 0 : overlapStart(bounds, cores[i - 1]!, overlapChars);
      chunks.push(chunkAt(i, start, core.end, await countSpan(start, core.end)));
    }
    if (round === MAX_RESPLIT_ROUNDS) break;
    let changed = false;
    cores = cores.flatMap((core, i) => {
      if (chunks[i]!.tokens <= o.maxTokens) return [core];
      const sub = splitCores(
        bounds,
        core.start,
        core.end,
        Math.max(1, Math.floor(core.budget / 2)),
      );
      if (sub.length > 1) changed = true;
      return sub;
    });
    if (!changed) break;
  }

  tooLong(chunks.length);
  assertTiling(chunks, text.length);
  return { chunks, totalTokens, charsPerToken };
}
