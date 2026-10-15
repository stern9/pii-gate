import { defaultDetectors, findingsOf, resolveOverlaps } from "./detectors/index.js";
import { PiiBlockedError } from "./errors.js";
import { LITERAL_CATEGORY, addCount, assertValidCategory, nullRecord } from "./types.js";
import type { AsyncDetector, Category, Detector, Finding, Policy, PolicyAction } from "./types.js";
import { InMemoryVault, normalizeValue, type Vault } from "./vault.js";

/** A known value from a structured record, masked without relying on detection. */
export interface SchemaHint {
  value: string | null | undefined;
  category: Category;
}

/**
 * Keyed by field name for readability at the call site, e.g.
 * `{ insuredName: { value: row.insured_name, category: "PERSON" } }`.
 * Empty and very short values (< 2 chars) are ignored.
 */
export type SchemaHints = Record<string, SchemaHint>;

export interface MaskOptions {
  /** Per-category action. Categories not listed use `defaultAction`. */
  policy?: Policy;
  /** Default "mask". */
  defaultAction?: PolicyAction;
  /** Default: all built-in detectors. Pass `[...defaultDetectors(), myNer]` to extend. */
  detectors?: readonly Detector[];
  schemaHints?: SchemaHints;
  /** Reuse a vault to share token numbering across several texts in one request. */
  vault?: Vault;
  /** Default 0.5. */
  minConfidence?: number;
  /**
   * Default true. Once a value is detected (usually via a cue like
   * "Insured:"), mask its other verbatim occurrences too.
   */
  propagate?: boolean;
  /**
   * Default true. Also propagate each part (>= 3 letters) of a detected
   * PERSON name, so "Kowalski's" is masked after "Claimant: Tomasz Kowalski".
   * Over-masks shared words (a surname that is also a street name).
   */
  propagateNameParts?: boolean;
  /**
   * Default true. Placeholder-shaped text already in the input (a `{{SSN_1}}`
   * typed by a user or planted in a document, or a case/whitespace variant such
   * as `{{ssn_1}}` or `{{ SSN_1 }}`) is masked as the
   * reserved category `LITERAL`, so the model sees `{{LITERAL_1}}` and
   * unmasking gives back the literal text `{{SSN_1}}`, never a vault value.
   * `false` passes such text through unchanged (pre-ADR-0002 behaviour), where
   * a planted token is restored to whatever the vault holds under that name.
   * Each spelling round-trips exactly. Mangled forms (`{{SSN_1}`, `[[SSN_1]]`) are not escaped.
   */
  escapePlaceholders?: boolean;
  /**
   * Default false. Leave exact tokens that the vault already held *before this
   * call* unescaped. Only for replayed assistant output (history the model
   * wrote and the caller resends) with a conversation-scoped vault. Tokens the
   * same call allocates never count, so a stale `{{PERSON_1}}` cannot bind to a
   * new value. Has no effect when `escapePlaceholders` is false.
   */
  keepIssuedPlaceholders?: boolean;
}

/**
 * Options for `maskAsync` / `maskAllAsync`: the same as `MaskOptions`, except
 * that detectors may be asynchronous (an NER model or service, ADR 0004).
 */
export interface MaskAsyncOptions extends Omit<MaskOptions, "detectors"> {
  /** Default: all built-in detectors. Pass `[...defaultDetectors(), nerDetector({ recognize })]` to add NER. */
  detectors?: readonly AsyncDetector[];
}

export interface MaskFinding extends Finding {
  action: PolicyAction;
  /** Placeholder that replaced the value; absent when the action was "allow". */
  token?: string;
}

export interface MaskResult {
  masked: string;
  vault: Vault;
  findings: MaskFinding[];
}

const HINT_CONFIDENCE = 1;
const MIN_HINT_LENGTH = 2;
const MIN_PROPAGATION_LENGTH = 3;
const DEFAULT_MIN_CONFIDENCE = 0.5;
/**
 * Placeholder-shaped text to escape: exact tokens plus case and inner-whitespace
 * variants (`{{ssn_1}}`, `{{ SSN_1 }}`) that a model could normalise into a real
 * token. Single-brace and bracket forms are left alone (too many false positives).
 */
const PLACEHOLDER = /\{\{\s*[A-Za-z][A-Za-z0-9_]*_\d+\s*\}\}/g;

/**
 * Exact placeholder-shaped spans already present in `text`. Those whose token is
 * in `issued` are returned as `kept` (left as written, but no other finding may
 * overlap them); the rest become LITERAL findings that win over everything.
 */
function placeholderSpans(
  text: string,
  options: Pick<MaskOptions, "escapePlaceholders" | "keepIssuedPlaceholders">,
  issued: ReadonlySet<string>,
): { literals: Finding[]; kept: Finding[] } {
  const literals: Finding[] = [];
  const kept: Finding[] = [];
  if (options.escapePlaceholders === false) return { literals, kept };
  for (const m of text.matchAll(PLACEHOLDER)) {
    const f: Finding = {
      category: LITERAL_CATEGORY,
      start: m.index,
      end: m.index + m[0].length,
      value: m[0],
      confidence: 1,
      detector: "placeholder-escape",
    };
    (options.keepIssuedPlaceholders === true && issued.has(m[0]) ? kept : literals).push(f);
  }
  return { literals, kept };
}

/** Tokens the vault holds right now; taken before a call allocates anything. */
function issuedTokens(vault: Vault | undefined, options: Pick<MaskOptions, "keepIssuedPlaceholders">): ReadonlySet<string> {
  if (!vault || options.keepIssuedPlaceholders !== true) return new Set();
  return new Set(vault.entries().map((e) => e.token));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches `value` with any whitespace run allowed where the value has whitespace, on word boundaries.
 * Case-insensitive unless `exactCase`.
 */
function occurrencePattern(value: string, exactCase = false): RegExp {
  const body = value.trim().split(/\s+/).map(escapeRegex).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, exactCase ? "gu" : "giu");
}

function findOccurrences(
  text: string,
  value: string,
  category: Category,
  confidence: number,
  detector: string,
  exactCase = false,
): Finding[] {
  const findings: Finding[] = [];
  try {
    // V8 compiles a pattern on first use, so "regular expression too large" can come from either step.
    for (const m of text.matchAll(occurrencePattern(value, exactCase))) {
      const start = m.index;
      findings.push({ category, start, end: start + m[0].length, value: m[0], confidence, detector });
    }
  } catch {
    // The engine's error quotes the whole pattern, i.e. the value. Never rethrow or chain it.
    throw new RangeError(
      `pii-gate: a ${category} value of ${value.length} characters is too long to search for; refusing to continue with possibly unmasked text.`,
    );
  }
  return findings;
}

function hintFindings(text: string, hints: SchemaHints | undefined): Finding[] {
  if (!hints) return [];
  return Object.entries(hints).flatMap(([field, hint]) => {
    const value = hint.value?.trim();
    if (!value || value.length < MIN_HINT_LENGTH) return [];
    assertValidCategory(hint.category);
    return findOccurrences(text, value, hint.category, HINT_CONFIDENCE, `schema:${field}`);
  });
}

function overlapsAny(f: Finding, others: readonly Finding[]): boolean {
  return others.some((o) => f.start < o.end && o.start < f.end);
}

/** A value already identified somewhere in the request, to be masked wherever else it appears. */
export type Seed = Pick<Finding, "value" | "category" | "confidence">;

/**
 * A seed after name-part expansion; parts match only as written, so "May" does not mask "may".
 * `canonical` is the full name a part belongs to, when exactly one detected name has that part.
 */
type ExpandedSeed = Seed & { exactCase?: boolean; canonical?: string };

/**
 * Full name a propagated name-part finding stands for, so `applyFindings` gives "Whitfield" the
 * token of "Dana Whitfield" instead of a second PERSON token. Kept off the finding object itself
 * so the extra value never shows up in `MaskFinding`s, logs, or serialized findings.
 */
const canonicalValues = new WeakMap<Finding, string>();

/**
 * Finds further verbatim occurrences of `seeds` in `text` that do not
 * overlap `existing`. This is what catches "spoke with Maria Gonzalez" after
 * "Claimant: Maria Gonzalez" was detected via its cue.
 */
export function propagateFindings(
  text: string,
  seeds: readonly Seed[],
  existing: readonly Finding[],
  options: Pick<MaskOptions, "propagateNameParts" | "minConfidence"> = {},
): Finding[] {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const usable = seeds.filter((s) => s.category !== LITERAL_CATEGORY);
  const all: readonly ExpandedSeed[] = options.propagateNameParts === false ? usable : withNameParts(usable);
  // Propagated findings obey the same cutoff as detected ones (name parts carry confidence x 0.8).
  const expanded = all.filter((s) => s.confidence >= minConfidence);
  const seen = new Set<string>();
  const extra: Finding[] = [];
  for (const seed of expanded) {
    const spelled = seed.value.replace(/\s+/g, " ");
    const key = `${seed.category}\u0000${seed.exactCase ? spelled : spelled.toLowerCase()}`;
    if (seen.has(key) || seed.value.trim().length < MIN_PROPAGATION_LENGTH) continue;
    seen.add(key);
    const hits = findOccurrences(text, seed.value, seed.category, seed.confidence, "propagation", seed.exactCase);
    for (const hit of hits) {
      if (overlapsAny(hit, existing) || overlapsAny(hit, extra)) continue;
      if (seed.canonical !== undefined) canonicalValues.set(hit, seed.canonical);
      extra.push(hit);
    }
  }
  return extra;
}

const NAME_PART = /^\p{Lu}[\p{L}'’-]{2,}$/u;

/**
 * Full values first (so they win over parts), then the individual name parts at lower
 * confidence. Parts are case-sensitive: a part like "May" or "Bill" is also an ordinary word.
 * A part shared by exactly one distinct full name carries it as `canonical` (same token as the
 * full name); a part shared by two different names ("Dana Whitfield", "Sam Whitfield") is
 * ambiguous and gets no canonical, so it is masked under a token of its own.
 */
function withNameParts(seeds: readonly Seed[]): ExpandedSeed[] {
  const parts = seeds
    .filter((s) => s.category === "PERSON")
    .flatMap((s) =>
      s.value
        .split(/\s+/)
        .filter((p) => NAME_PART.test(p))
        .map((value) => ({ value, category: s.category, confidence: s.confidence * 0.8, full: s.value })),
    );
  const owners = new Map<string, Set<string>>();
  for (const p of parts) {
    const set = owners.get(p.value) ?? new Set<string>();
    set.add(normalizeValue(p.full));
    owners.set(p.value, set);
  }
  const expanded = parts.map(({ full, ...p }): ExpandedSeed => {
    const unambiguous = owners.get(p.value)?.size === 1;
    return unambiguous ? { ...p, exactCase: true, canonical: full } : { ...p, exactCase: true };
  });
  return [...seeds].sort((a, b) => b.value.length - a.value.length).concat(expanded);
}

/**
 * Schema hints plus detector output for one text, without propagation.
 * Hints are trusted over detectors, so detector findings that collide with
 * a hint are dropped.
 */
export function detectFindings(text: string, options: MaskOptions = {}): Finding[] {
  return analyze(text, options, issuedTokens(options.vault, options), runDetectors(text, options.detectors)).findings;
}

/** Raw output of synchronous detectors. Rejects a detector that returns a promise (or anything but an array). */
function runDetectors(text: string, detectors: readonly Detector[] | undefined): Finding[] {
  return (detectors ?? defaultDetectors()).flatMap((d) => findingsOf(d, d.detect(text)));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Raw output of possibly-async detectors; all detectors for one text run
 * concurrently. Returns synchronously when no detector returned a promise, so
 * regex-only callers of the async API pay no extra microtasks.
 */
function runDetectorsAsync(
  text: string,
  detectors: readonly AsyncDetector[] | undefined,
): Finding[] | Promise<Finding[]> {
  const list = detectors ?? defaultDetectors();
  // A synchronous throw becomes a rejection, so promises already started by other detectors are still awaited by Promise.all (no unhandled rejection).
  const outs = list.map((d) => {
    try {
      return d.detect(text);
    } catch (err) {
      return Promise.reject(err);
    }
  });
  const flatten = (results: readonly unknown[]): Finding[] =>
    results.flatMap((out, i) => findingsOf(list[i] ?? { name: "(unnamed)" }, out));
  return outs.some(isThenable) ? Promise.all(outs).then(flatten) : flatten(outs);
}

interface Analysis {
  /** Findings to apply, including LITERAL escapes. */
  findings: Finding[];
  /** Spans no propagated finding may touch: everything in `findings` plus kept (issued) placeholders. */
  occupied: Finding[];
}

/**
 * `raw` is the detectors' output for `text`, computed by the caller (synchronously
 * for `mask`, awaited for `maskAsync`), so both paths share everything after detection.
 */
function analyze(text: string, options: MaskAsyncOptions, issued: ReadonlySet<string>, raw: readonly Finding[]): Analysis {
  const { literals, kept } = placeholderSpans(text, options, issued);
  const reserved = [...literals, ...kept];
  const hints = resolveOverlaps(hintFindings(text, options.schemaHints).filter((f) => !overlapsAny(f, reserved)));
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  for (const f of raw) assertValidCategory(f.category);
  const detected = raw.filter(
    (f) => f.confidence >= minConfidence && !overlapsAny(f, hints) && !overlapsAny(f, reserved),
  );
  const findings = [...literals, ...hints, ...resolveOverlaps(detected)].sort((a, b) => a.start - b.start);
  return { findings, occupied: [...findings, ...kept] };
}

/** Final, non-overlapping findings for a single text, sorted by position. */
export function collectFindings(text: string, options: MaskOptions = {}): Finding[] {
  const raw = runDetectors(text, options.detectors);
  return withPropagation(text, options, analyze(text, options, issuedTokens(options.vault, options), raw));
}

function withPropagation(text: string, options: MaskAsyncOptions, { findings, occupied }: Analysis): Finding[] {
  if (options.propagate === false) return findings;
  return [...findings, ...propagateFindings(text, findings, occupied, options)].sort((a, b) => a.start - b.start);
}

export function actionFor(category: Category, options: Pick<MaskOptions, "policy" | "defaultAction">): PolicyAction {
  // Escaped placeholder text is not PII and must never pass through or block: it is always masked.
  if (category === LITERAL_CATEGORY) return "mask";
  return options.policy?.[category] ?? options.defaultAction ?? "mask";
}

export function countByCategory(findings: readonly Pick<Finding, "category">[]): Record<string, number> {
  const counts = nullRecord<number>();
  for (const f of findings) addCount(counts, f.category);
  return counts;
}

export function assertNotBlocked(
  findings: readonly Finding[],
  options: Pick<MaskOptions, "policy" | "defaultAction">,
): void {
  const blocked = findings.filter((f) => actionFor(f.category, options) === "block");
  if (blocked.length > 0) throw new PiiBlockedError(countByCategory(blocked));
}

/** Replaces precomputed, non-overlapping, position-sorted findings with vault tokens according to policy. */
export function applyFindings(
  text: string,
  findings: readonly Finding[],
  vault: Vault,
  options: Pick<MaskOptions, "policy" | "defaultAction">,
): MaskResult {
  const out: string[] = [];
  const results: MaskFinding[] = [];
  let cursor = 0;
  for (const f of findings) {
    const action = actionFor(f.category, options);
    if (action === "allow") {
      results.push({ ...f, action });
      continue;
    }
    const token = vault.set(canonicalValues.get(f) ?? f.value, f.category);
    out.push(text.slice(cursor, f.start), token);
    cursor = f.end;
    results.push({ ...f, action, token });
  }
  out.push(text.slice(cursor));
  return { masked: out.join(""), vault, findings: results };
}

/**
 * Detects PII in `text` and replaces it with typed placeholders such as
 * `{{PERSON_1}}`. Throws `PiiBlockedError` (before touching the vault) if
 * any finding falls in a category whose policy is "block".
 */
export function mask(text: string, options: MaskOptions = {}): MaskResult {
  const vault = options.vault ?? new InMemoryVault();
  const findings = collectFindings(text, options);
  assertNotBlocked(findings, options);
  return applyFindings(text, findings, vault, options);
}

/**
 * `mask` with detectors that may be asynchronous (ADR 0004). With only
 * synchronous detectors the result is identical to `mask`. A detector that
 * rejects (e.g. `nerDetector` with `onError: "throw"`) rejects the call
 * before any token is issued.
 */
export async function maskAsync(text: string, options: MaskAsyncOptions = {}): Promise<MaskResult> {
  const vault = options.vault ?? new InMemoryVault();
  const issued = issuedTokens(vault, options);
  const raw = await runDetectorsAsync(text, options.detectors);
  const findings = withPropagation(text, options, analyze(text, options, issued, raw));
  assertNotBlocked(findings, options);
  return applyFindings(text, findings, vault, options);
}

export interface MaskAllResult {
  masked: string[];
  vault: Vault;
  findings: MaskFinding[][];
}

/**
 * Masks several texts that belong to one request (system prompt, messages,
 * tool results) with a single vault. Detection runs over every text before
 * anything is replaced, so:
 *  - a block anywhere aborts the whole request before any token is issued;
 *  - a name found via a cue in one text is also masked where it appears
 *    uncued in another;
 *  - values already in a reused vault are masked wherever they reappear.
 */
export function maskAll(texts: readonly string[], options: MaskOptions = {}): MaskAllResult {
  return maskTexts(
    texts.map((text) => ({ text })),
    options,
  );
}

/** One text for `maskTexts`; `keepIssuedPlaceholders` overrides the option for this text only. */
export interface MaskInput {
  text: string;
  keepIssuedPlaceholders?: boolean;
}

/**
 * `maskAll` with a per-text `keepIssuedPlaceholders`, so the Anthropic wrapper
 * can exempt replayed assistant turns only. The issued-token snapshot is taken
 * once, before detection, so tokens allocated by this call never count.
 */
export function maskTexts(inputs: readonly MaskInput[], options: MaskOptions = {}): MaskAllResult {
  const vault = options.vault ?? new InMemoryVault();
  const issued = new Set(vault.entries().map((e) => e.token));
  const raws = inputs.map((input) => runDetectors(input.text, options.detectors));
  return maskAnalyzed(inputs, options, vault, issued, raws);
}

/**
 * `maskAll` with detectors that may be asynchronous (ADR 0004). Detection for
 * every text runs concurrently and completes before anything is replaced, so
 * the cross-text guarantees of `maskAll` hold: a block anywhere aborts the
 * request before any token is issued, and a name an NER detector finds in one
 * text is propagated to the others. With only synchronous detectors the result
 * is identical to `maskAll`.
 */
export async function maskAllAsync(texts: readonly string[], options: MaskAsyncOptions = {}): Promise<MaskAllResult> {
  return maskTextsAsync(
    texts.map((text) => ({ text })),
    options,
  );
}

/** `maskTexts` with possibly-async detectors; used by `wrapAnthropic`. */
export async function maskTextsAsync(inputs: readonly MaskInput[], options: MaskAsyncOptions = {}): Promise<MaskAllResult> {
  const vault = options.vault ?? new InMemoryVault();
  // Snapshot before awaiting detection: tokens a concurrent call allocates meanwhile never count as issued.
  const issued = new Set(vault.entries().map((e) => e.token));
  const pending = inputs.map((input) => runDetectorsAsync(input.text, options.detectors));
  const raws = pending.some(isThenable) ? await Promise.all(pending) : (pending as Finding[][]);
  return maskAnalyzed(inputs, options, vault, issued, raws);
}

/** Everything after detection, shared by the sync and async paths. */
function maskAnalyzed(
  inputs: readonly MaskInput[],
  options: MaskAsyncOptions,
  vault: Vault,
  issued: ReadonlySet<string>,
  raws: readonly (readonly Finding[])[],
): MaskAllResult {
  const none: ReadonlySet<string> = new Set();
  const analyses = inputs.map((input, i) => {
    const keep = input.keepIssuedPlaceholders ?? options.keepIssuedPlaceholders ?? false;
    return analyze(input.text, { ...options, keepIssuedPlaceholders: keep }, keep ? issued : none, raws[i] ?? []);
  });
  const base = analyses.map((a) => a.findings);
  const perText =
    options.propagate === false
      ? base
      : analyses.map(({ findings: own, occupied }, i) => {
          const seeds: Seed[] = [...base.flat(), ...vault.entries().map((e) => ({ ...e, confidence: 1 }))];
          const extra = propagateFindings(inputs[i]?.text ?? "", seeds, occupied, options);
          return [...own, ...extra].sort((a, b) => a.start - b.start);
        });
  assertNotBlocked(perText.flat(), options);
  const results = inputs.map((input, i) => applyFindings(input.text, perText[i] ?? [], vault, options));
  return { masked: results.map((r) => r.masked), vault, findings: results.map((r) => r.findings) };
}
