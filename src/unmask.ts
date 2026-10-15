import { LITERAL_CATEGORY, addCount, nullRecord, type Category, type JsonValue } from "./types.js";
import type { Vault } from "./vault.js";

/**
 * - `near-match`: a damaged placeholder, left as written (see `suggestion`).
 * - `unknown-token`: an exact placeholder the vault never issued, left as written.
 * - `withheld`: a valid placeholder deliberately left unrestored by a restore
 *   filter (e.g. the wrapper's `restoreToolInputs`). Not a model error.
 */
export type UnmaskWarningKind = "near-match" | "unknown-token" | "withheld";

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
  /** `restored`, split by category (`LITERAL` included). */
  restoredByCategory: Record<string, number>;
}

export interface UnmaskDeepResult<T> {
  value: T;
  warnings: UnmaskWarning[];
  restored: number;
  restoredByCategory: Record<string, number>;
}

/**
 * Decides whether one known placeholder is restored. `path` is the JSON
 * Pointer of the string inside the value for `unmaskDeep` ("" for `unmask`).
 * Return false to leave the token in place; it is reported as `withheld`.
 * Never consulted for `LITERAL` tokens (escaped input text, not PII), which
 * are always restored, nor for tokens the vault does not hold.
 */
export type RestoreFilter = (token: string, category: Category, path: string) => boolean;

export interface UnmaskOptions {
  shouldRestore?: RestoreFilter;
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
export function unmask(text: string, vault: Vault, options: UnmaskOptions = {}): UnmaskResult {
  return unmaskAt(text, vault, options, "");
}

/** Category part of an exact token's inner text: `A_B_12` -> `A_B`. */
function categoryOf(inner: string): Category {
  return inner.replace(/_\d+$/, "");
}

function unmaskAt(text: string, vault: Vault, options: UnmaskOptions, path: string): UnmaskResult {
  const warnings: UnmaskWarning[] = [];
  const exactSpans: Span[] = [];
  const restoredByCategory = nullRecord<number>();
  let restored = 0;
  const out = text.replace(EXACT_TOKEN, (token: string, inner: string, index: number) => {
    exactSpans.push({ start: index, end: index + token.length });
    const value = vault.get(token);
    if (value === undefined) {
      warnings.push({ kind: "unknown-token", found: token, index });
      return token;
    }
    const category = categoryOf(inner);
    if (category !== LITERAL_CATEGORY && options.shouldRestore?.(token, category, path) === false) {
      warnings.push({ kind: "withheld", found: token, index });
      return token;
    }
    restored++;
    addCount(restoredByCategory, category);
    return value;
  });
  warnings.push(...nearMatchWarnings(text, vault, exactSpans));
  warnings.sort((a, b) => a.index - b.index);
  return { text: out, warnings, restored, restoredByCategory };
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

interface DeepState {
  vault: Vault;
  options: UnmaskOptions;
  warnings: UnmaskWarning[];
  restored: number;
  restoredByCategory: Record<string, number>;
}

function walk(value: unknown, path: string, state: DeepState): unknown {
  if (typeof value === "string") {
    const r = unmaskAt(value, state.vault, state.options, path);
    state.restored += r.restored;
    for (const [category, n] of Object.entries(r.restoredByCategory)) {
      addCount(state.restoredByCategory, category, n);
    }
    state.warnings.push(...r.warnings.map((w) => ({ ...w, path })));
    return r.text;
  }
  if (Array.isArray(value)) return value.map((item, i) => walk(item, `${path}/${i}`, state));
  if (value !== null && typeof value === "object") {
    // fromEntries defines own properties, so a JSON key "__proto__" stays a key instead of setting the prototype.
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, `${path}/${escapePointer(k)}`, state)]));
  }
  return value;
}

/**
 * Walks any JSON-like value (e.g. tool_use `input`) and unmasks every string.
 * Object keys are left untouched. `options.shouldRestore` can hold back
 * individual tokens by category and JSON Pointer path. Returns a new value; the input is not mutated.
 */
export function unmaskDeep<T extends JsonValue | object>(
  value: T,
  vault: Vault,
  options: UnmaskOptions = {},
): UnmaskDeepResult<T> {
  const state: DeepState = { vault, options, warnings: [], restored: 0, restoredByCategory: nullRecord<number>() };
  // walk() preserves shape: only string leaves change, so the cast is sound.
  const out = walk(value, "", state) as T;
  return { value: out, warnings: state.warnings, restored: state.restored, restoredByCategory: state.restoredByCategory };
}

/** Counts exact placeholder occurrences (known or not) in a string. */
export function countTokens(text: string): number {
  return [...text.matchAll(EXACT_TOKEN)].length;
}
