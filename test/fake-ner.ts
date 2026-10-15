import type { NerEntity } from "../src/index.js";

export interface FakeNerOptions {
  label?: string;
  score?: number;
  /** Match only the exact spelling in `names` (default: case-insensitive). */
  caseSensitive?: boolean;
  /** Return `word` only, no offsets (like transformers.js output without start/end). */
  wordOnly?: boolean;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A deterministic stand-in for an NER model: tags every whole-word occurrence
 * of the given (fake) names. No network, no model.
 */
export function fakeRecognize(names: readonly string[], options: FakeNerOptions = {}): (text: string) => NerEntity[] {
  const flags = options.caseSensitive ? "gu" : "giu";
  const patterns = names.map((n) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(n)}(?![\\p{L}\\p{N}])`, flags));
  return (text) =>
    patterns.flatMap((p) =>
      [...text.matchAll(p)].map((m): NerEntity => {
        const base = { label: options.label ?? "PER", score: options.score ?? 0.93 };
        return options.wordOnly ? { ...base, word: m[0] } : { ...base, start: m.index, end: m.index + m[0].length, word: m[0] };
      }),
    );
}

/** The same recognizer, resolved asynchronously after `delayMs` (default: next macrotask). */
export function fakeRecognizeAsync(
  names: readonly string[],
  options: FakeNerOptions & { delayMs?: number } = {},
): (text: string) => Promise<NerEntity[]> {
  const sync = fakeRecognize(names, options);
  return (text) => new Promise((resolve) => setTimeout(() => resolve(sync(text)), options.delayMs ?? 0));
}
