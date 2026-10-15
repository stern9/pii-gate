import type { JsonValue } from "./types.js";
import type { Vault } from "./vault.js";

export type UnmaskWarningKind = "near-match" | "unknown-token";

/** Warnings carry tokens and positions only — never the original values. */
export interface UnmaskWarning {
  kind: UnmaskWarningKind;
  /** The text as the model wrote it, e.g. "{SSN_1}}" or "{{person_2}}". */
  found: string;
  /** For near-matches: the vault token it most likely meant. */
  suggestion?: string;
  index: number;
  /** JSON Pointer to the string inside the value, for `unmaskDeep`. */
  path?: string;
}

export interface UnmaskResult {
  text: string;
  warnings: UnmaskWarning[];
  /** Number of placeholders restored. */
  restored: number;
}

export interface UnmaskDeepResult<T> {
  value: T;
  warnings: UnmaskWarning[];
  restored: number;
}

const EXACT_TOKEN = /\{\{([A-Z][A-Z0-9_]*_\d+)\}\}/g;

/**
 * Candidates for a mangled token: one or two opening brackets/braces with
 * zero to two closing ones (or vice versa), any case, `_`/space/`-` before
 * the number. Bare `PERSON_1` is caught separately against known categories.
 */
const LOOSE_BRACED = /[{[]{1,2}\s*([A-Za-z][A-Za-z0-9_]*?)[_ -](\d{1,5})\s*[}\]]{0,2}|([A-Za-z][A-Za-z0-9_]*?)[_ -](\d{1,5})\s*[}\]]{1,2}/g;

interface Span {
  start: number;
  end: number;
}

function overlaps(a: Span, spans: readonly Span[]): boolean {
  return spans.some((s) => a.start < s.end && s.start < a.end);
}

function knownCategories(vault: Vault): string[] {
  return [...new Set(vault.entries().map((e) => e.category))];
}

function bareTokenPattern(categories: readonly string[]): RegExp | undefined {
  if (categories.length === 0) return undefined;
  const alternatives = [...categories].sort((a, b) => b.length - a.length).join("|");
  return new RegExp(`(?<![A-Za-z0-9_{\\[])(${alternatives})[_ ](\\d{1,5})(?![A-Za-z0-9_}\\]])`, "gi");
}

function nearMatchWarnings(text: string, vault: Vault, exact: readonly Span[]): UnmaskWarning[] {
  const warnings: UnmaskWarning[] = [];
  const claimed: Span[] = [...exact];
  const consider = (start: number, found: string, category: string | undefined, num: string | undefined): void => {
    const span = { start, end: start + found.length };
    if (!category || !num || overlaps(span, claimed)) return;
    const suggestion = `{{${category.toUpperCase()}_${num}}}`;
    if (vault.get(suggestion) === undefined) return;
    claimed.push(span);
    warnings.push({ kind: "near-match", found, suggestion, index: start });
  };
  for (const m of text.matchAll(LOOSE_BRACED)) consider(m.index, m[0], m[1] ?? m[3], m[2] ?? m[4]);
  const bare = bareTokenPattern(knownCategories(vault));
  if (bare) for (const m of text.matchAll(bare)) consider(m.index, m[0], m[1], m[2]);
  return warnings;
}

/**
 * Restores exact `{{CATEGORY_n}}` placeholders from the vault. Anything that
 * looks like a damaged placeholder is reported in `warnings` and left as-is:
 * guessing could put one customer's data into a sentence about another.
 */
export function unmask(text: string, vault: Vault): UnmaskResult {
  const warnings: UnmaskWarning[] = [];
  const exactSpans: Span[] = [];
  let restored = 0;
  const out = text.replace(EXACT_TOKEN, (token: string, _inner: string, index: number) => {
    exactSpans.push({ start: index, end: index + token.length });
    const value = vault.get(token);
    if (value === undefined) {
      warnings.push({ kind: "unknown-token", found: token, index });
      return token;
    }
    restored++;
    return value;
  });
  warnings.push(...nearMatchWarnings(text, vault, exactSpans));
  warnings.sort((a, b) => a.index - b.index);
  return { text: out, warnings, restored };
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

interface DeepState {
  vault: Vault;
  warnings: UnmaskWarning[];
  restored: number;
}

function walk(value: unknown, path: string, state: DeepState): unknown {
  if (typeof value === "string") {
    const r = unmask(value, state.vault);
    state.restored += r.restored;
    state.warnings.push(...r.warnings.map((w) => ({ ...w, path })));
    return r.text;
  }
  if (Array.isArray(value)) return value.map((item, i) => walk(item, `${path}/${i}`, state));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, `${path}/${escapePointer(k)}`, state);
    return out;
  }
  return value;
}

/**
 * Walks any JSON-like value (e.g. tool_use `input`) and unmasks every string.
 * Object keys are left untouched. Returns a new value; the input is not mutated.
 */
export function unmaskDeep<T extends JsonValue | object>(value: T, vault: Vault): UnmaskDeepResult<T> {
  const state: DeepState = { vault, warnings: [], restored: 0 };
  // walk() preserves shape: only string leaves change, so the cast is sound.
  const out = walk(value, "", state) as T;
  return { value: out, warnings: state.warnings, restored: state.restored };
}

/** Counts exact placeholder occurrences (known or not) in a string. */
export function countTokens(text: string): number {
  return [...text.matchAll(EXACT_TOKEN)].length;
}
