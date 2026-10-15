import { assertValidCategory, type AsyncDetector, type Category, type Detector, type Finding } from "../types.js";
import { PERSON_STOP_WORDS } from "./person.js";

/**
 * One entity from a named-entity model, in the model's own label set.
 *
 * Give `start`/`end` (UTF-16 offsets into the text, `end` exclusive, as
 * `String.prototype.slice` uses), `word` (the entity text), or both. With
 * both, the span is used when it reads as `word` ignoring case, accents,
 * Unicode normalisation, whitespace and punctuation ("jose nunez" for
 * "José Núñez", "Jean - Luc" for "Jean-Luc"); otherwise `word` is searched for,
 * and if it is nowhere in the text the offsets are used after all. With `word`
 * only, every whole-word occurrence is reported. Offsets from Python services
 * are code points, which differ from UTF-16 after an emoji; sending `word` too
 * makes such spans recoverable. Tokenizer pieces ("##son", "Ġjordan") are not
 * usable as `word`; a SentencePiece "▁" reads as a space.
 */
export interface NerEntity {
  /** Model label: "PER", "B-PER", "PERSON", ... (case-insensitive; a B-/I-/E-/S-/L-/U- prefix is ignored). */
  label: string;
  /** 0..1. Entities without a score are accepted at confidence 0.8 and are not subject to `minScore`. */
  score?: number | undefined;
  start?: number | undefined;
  end?: number | undefined;
  word?: string | undefined;
}

export interface NerRecognizeContext {
  /** Aborted when `timeoutMs` elapses; pass it to `fetch` or your model runtime. */
  signal: AbortSignal;
}

export type NerRecognize = (
  text: string,
  context: NerRecognizeContext,
) => readonly NerEntity[] | PromiseLike<readonly NerEntity[]>;

/** A synchronous recognizer, for which `nerDetector` returns a plain `Detector`. */
export type NerRecognizeSync = (text: string, context: NerRecognizeContext) => readonly NerEntity[];

export type NerFailureReason = "error" | "timeout" | "invalid-output";

export interface NerFailure {
  detector: string;
  reason: NerFailureReason;
  /**
   * What `recognize` threw or rejected with (absent for timeouts and invalid
   * output). It comes from your model or service and may quote the input
   * text: do not log it as-is.
   */
  error?: unknown;
}

export interface NerDetectorOptions {
  /** Runs the model. Called once per text; never logged or wrapped by pii-gate. */
  recognize: NerRecognize;
  /** Detector name, recorded on findings. Default "ner". */
  name?: string;
  /**
   * Model label -> pii-gate category. Replaces the default, which is
   * `{ PER: "PERSON", PERSON: "PERSON" }`. Entities with other labels are
   * dropped. Locations and organisations are not mapped by default (see ADR 0004).
   */
  labels?: Readonly<Record<string, Category>>;
  /** Entities scored below this are dropped. Default 0.7. */
  minScore?: number;
  /**
   * Default false. Keep only spans whose first letter is uppercase. Off by
   * default because lowercase names ("spoke with jordan ellery") are the gap
   * NER is meant to close; turn it on for a model that over-fires on
   * lowercase common words.
   */
  requireCapitalized?: boolean;
  /**
   * Default "throw": a failing recognizer rejects the whole masking call with
   * `NerDetectorError`, so nothing is sent. "skip" continues with the other
   * detectors' findings only (regex still runs) and reports through `onFailure`.
   */
  onError?: "throw" | "skip";
  /**
   * Per-call timeout in ms (async recognizers only). On timeout the signal
   * passed to `recognize` is aborted and the call fails with reason "timeout".
   * pii-gate cannot stop the call itself: honour the signal. Default: none.
   */
  timeoutMs?: number;
  /**
   * Maximum concurrent `recognize` calls that pii-gate is waiting on (async
   * recognizers only). Default 4. A call that times out frees its slot at the
   * timeout, even if your recognizer keeps running, so a recognizer that
   * ignores the signal can have more than `concurrency` calls in flight
   * against a slow service. Pass `signal` to `fetch` or your model runtime.
   */
  concurrency?: number;
  /** Called on every failure, in both `onError` modes. Exceptions it throws are ignored. */
  onFailure?: (failure: NerFailure) => void;
}

/**
 * The NER recognizer failed, timed out or returned something other than an
 * array. Carries the detector name and reason only, never input text or the
 * underlying error (which may quote the text); use `onFailure` to see that.
 */
export class NerDetectorError extends Error {
  override readonly name = "NerDetectorError";
  constructor(
    readonly detector: string,
    readonly reason: NerFailureReason,
  ) {
    super(
      `NER detector "${detector}" failed (${reason}); refusing to continue with possibly unmasked text. ` +
        `Set onError: "skip" to continue without its findings.`,
    );
  }
}

const DEFAULT_LABELS: Readonly<Record<string, Category>> = { PER: "PERSON", PERSON: "PERSON" };
const DEFAULT_MIN_SCORE = 0.7;
const UNSCORED_CONFIDENCE = 0.8;
const DEFAULT_CONCURRENCY = 4;
const BIO_PREFIX = /^[BIESLU]-/;
/**
 * Scripts written without spaces between words. Each of their characters is a
 * token of its own, and spans are not grown into neighbouring characters
 * (growing "王小明" inside "我是王小明" would take the whole run).
 */
const NO_SPACE =
  "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}\\p{Script=Tibetan}";
const NO_SPACE_CHAR = new RegExp(`[${NO_SPACE}]`, "u");
const ONLY_NO_SPACE = new RegExp(`^[${NO_SPACE}\\p{M}]+$`, "u");
/** Word characters, the same set for growing spans and for tokenising (`_` included, as in propagation's boundaries). */
const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;
const TOKEN = new RegExp(`[${NO_SPACE}]|(?:(?![${NO_SPACE}])[\\p{L}\\p{M}\\p{N}_])+`, "gu");
/** What may separate two tokens of one name in the text: a few spaces, or one hyphen/apostrophe/period with optional spaces. */
const NAME_GAP = /^(?:\s{0,4}|\s?[-‐‑–'’ʼ`´.]\s{0,3})$/u;
const LETTER = /\p{L}/gu;
const UPPER_FIRST = /^\P{L}*\p{Lu}/u;
const STOP_WORDS_LOWER: ReadonlySet<string> = new Set([...PERSON_STOP_WORDS].map((w) => w.toLowerCase()));

/**
 * Limits on what one `recognize` result may expand into. Exceeding the first
 * three is `invalid-output` (so `onError` decides) instead of unbounded time and
 * memory from a recognizer that tags every token of a long document. Spans or
 * words longer than the last two are not names: they are dropped (a BIO chain
 * stops merging at the limit instead), which also keeps every search pattern small.
 */
const NER_LIMITS = Object.freeze({
  /** Entities in one result. */
  maxEntities: 100_000,
  /** Spans produced by `word` searches (offset spans are bounded by `maxEntities`). */
  maxWordSpans: 10_000,
  /** Candidate positions examined across all `word` searches. */
  maxWordCandidates: 100_000,
  /** Characters in one span or `word`. */
  maxSpanChars: 128,
  /** Tokens (words; characters in CJK/Thai) in one span or `word`. */
  maxSpanTokens: 16,
});

function normalizeLabel(label: string): string {
  return label.trim().toUpperCase().replace(BIO_PREFIX, "");
}

/** BIO/BILOU prefix of a label ("" for none). */
type Prefix = "" | "B" | "I" | "E" | "S" | "L" | "U";
/** A span may continue the previous one only if it carries a continuation prefix and the previous one was still open. */
const OPENS: ReadonlySet<Prefix> = new Set<Prefix>(["B", "I"]);
const CONTINUES: ReadonlySet<Prefix> = new Set<Prefix>(["I", "E", "L"]);

function parseLabel(label: string): { base: string; prefix: Prefix } {
  const upper = label.trim().toUpperCase();
  return BIO_PREFIX.test(upper) ? { base: upper.slice(2), prefix: upper[0] as Prefix } : { base: upper, prefix: "" };
}

/** Case-, accent- and compatibility-insensitive form of one token: "Núñez" (NFC or NFD), "NUNEZ" and "nunez" agree. */
function looseKey(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** `looseKey` without whitespace and punctuation, for comparing a span with `word`: "Jean - Luc" and "Jean-Luc" agree. */
function looseCompact(s: string): string {
  return looseKey(s).replace(/[^\p{L}\p{N}]/gu, "");
}

function isThenable<T>(value: unknown): value is PromiseLike<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

interface Span {
  start: number;
  end: number;
  category: Category;
  confidence: number;
  prefix: Prefix;
}

const OVERFLOW = Symbol("overflow");

function tokenCount(s: string): number {
  let n = 0;
  for (const _ of s.matchAll(TOKEN)) n++;
  return n;
}

/**
 * A usable `word`: its token keys, or undefined when it is missing, too long, or
 * a tokenizer piece. WordPiece continuations ("##son") and byte-level BPE pieces
 * ("Ġjordan") are rejected rather than searched: "##son" would otherwise mask
 * every "son" while "Johnson" leaks. A SentencePiece marker ("▁jordan▁ellery")
 * is read as a space.
 */
function wordKeys(word: unknown): string[] | undefined {
  if (typeof word !== "string" || word.length > NER_LIMITS.maxSpanChars * 2) return undefined;
  const trimmed = word.trim();
  if (trimmed.startsWith("##") || trimmed.startsWith("Ġ")) return undefined;
  const text = trimmed.replace(/▁/g, " ").trim();
  if (text === "" || text.length > NER_LIMITS.maxSpanChars) return undefined;
  const keys = [...text.matchAll(TOKEN)].map((m) => looseKey(m[0]));
  return keys.length > 0 && keys.length <= NER_LIMITS.maxSpanTokens ? keys : undefined;
}

/**
 * Whole-word search for entity `word`s without building a regex from model
 * output. The text is tokenised once; a word is looked up by its rarest token
 * and checked token by token around each candidate, so cost is bounded by that
 * token's occurrences, not words x text. Matching is on `looseKey`s, and the
 * text between two tokens must look like a gap inside a name (`NAME_GAP`).
 */
class WordSearch {
  private starts: number[] = [];
  private ends: number[] = [];
  private keys: string[] = [];
  private byKey: Map<string, number[]> | undefined;
  private readonly cache = new Map<string, readonly [number, number][]>();
  private candidates = 0;

  constructor(private readonly text: string) {}

  private index(): Map<string, number[]> {
    if (this.byKey) return this.byKey;
    const byKey = new Map<string, number[]>();
    for (const m of this.text.matchAll(TOKEN)) {
      const key = looseKey(m[0]);
      const i = this.keys.length;
      this.starts.push(m.index);
      this.ends.push(m.index + m[0].length);
      this.keys.push(key);
      const list = byKey.get(key);
      if (list) list.push(i);
      else byKey.set(key, [i]);
    }
    this.byKey = byKey;
    return byKey;
  }

  find(word: readonly string[]): readonly [number, number][] | typeof OVERFLOW {
    const cacheKey = word.join("\u0000");
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const byKey = this.index();
    let anchor = 0;
    let anchorHits: readonly number[] = [];
    for (let k = 0; k < word.length; k++) {
      const hits = byKey.get(word[k] ?? "") ?? [];
      if (k === 0 || hits.length < anchorHits.length) {
        anchor = k;
        anchorHits = hits;
      }
    }
    const found: [number, number][] = [];
    for (const at of anchorHits) {
      if (++this.candidates > NER_LIMITS.maxWordCandidates) return OVERFLOW;
      const first = at - anchor;
      const last = first + word.length - 1;
      if (first < 0 || last >= this.keys.length) continue;
      let ok = true;
      for (let k = 0; ok && k < word.length; k++) {
        const i = first + k;
        if (this.keys[i] !== word[k]) ok = false;
        else if (k > 0 && !NAME_GAP.test(this.text.slice(this.ends[i - 1] ?? 0, this.starts[i] ?? 0))) ok = false;
      }
      if (ok) found.push([this.starts[first] ?? 0, this.ends[last] ?? 0]);
    }
    this.cache.set(cacheKey, found);
    return found;
  }
}

function validOffsets(text: string, e: NerEntity): e is NerEntity & { start: number; end: number } {
  return (
    Number.isInteger(e.start) &&
    Number.isInteger(e.end) &&
    (e.start as number) >= 0 &&
    (e.end as number) <= text.length &&
    (e.start as number) < (e.end as number)
  );
}

function growsInto(a: string, b: string): boolean {
  return WORD_CHAR.test(a) && WORD_CHAR.test(b) && !NO_SPACE_CHAR.test(a) && !NO_SPACE_CHAR.test(b);
}

/**
 * Grows a span to whole words (a sub-word token must not leave the rest of the
 * name visible; not in scripts written without spaces), then trims punctuation
 * and whitespace at its edges.
 */
function cleanSpan(text: string, start: number, end: number): [number, number] | undefined {
  let s = start;
  let t = end;
  while (s > 0 && growsInto(text[s - 1] ?? "", text[s] ?? "")) s--;
  while (t < text.length && growsInto(text[t - 1] ?? "", text[t] ?? "")) t++;
  while (s < t && !WORD_CHAR.test(text[s] ?? "")) s++;
  while (t > s && !WORD_CHAR.test(text[t - 1] ?? "")) t--;
  return s < t ? [s, t] : undefined;
}

function withinLimits(value: string): boolean {
  return value.length <= NER_LIMITS.maxSpanChars && tokenCount(value) <= NER_LIMITS.maxSpanTokens;
}

function hasTwoLetters(value: string): boolean {
  return (value.match(LETTER)?.length ?? 0) >= 2;
}

/** Precision filters: at least two letters, optional capitalisation, and no span made only of field labels or stop words. */
function plausible(value: string, category: Category, requireCapitalized: boolean): boolean {
  if (!hasTwoLetters(value)) return false;
  if (requireCapitalized && !UPPER_FIRST.test(value)) return false;
  if (category === "PERSON") {
    const words = value.split(/[\s,]+/).filter(Boolean);
    if (words.every((w) => STOP_WORDS_LOWER.has(w.replace(/\.$/, "").toLowerCase()))) return false;
  }
  return true;
}

/**
 * Joins BIO continuations only: an I-/E-/L- span directly after a B-/I- span of
 * the same category, touching it or separated by spaces/tabs ("B-PER jordan" +
 * "I-PER ellery"). Two separate entities are never merged, so "Ana Ruiz Bo Li"
 * tagged as two names stays two names. A chain stops growing at the span
 * limits; the rest starts a new span.
 */
function mergeContinuations(text: string, spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const span of sorted) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.category === span.category &&
      OPENS.has(prev.prefix) &&
      CONTINUES.has(span.prefix) &&
      (span.start <= prev.end || /^[ \t]+$/.test(text.slice(prev.end, span.start))) &&
      withinLimits(text.slice(prev.start, Math.max(prev.end, span.end)))
    ) {
      prev.end = Math.max(prev.end, span.end);
      prev.confidence = Math.min(prev.confidence, span.confidence);
      prev.prefix = span.prefix;
      continue;
    }
    out.push({ ...span });
  }
  return out;
}

interface Settings {
  name: string;
  labels: ReadonlyMap<string, Category>;
  minScore: number;
  requireCapitalized: boolean;
}

/**
 * Validates and converts model output into findings. A bad entity is dropped,
 * never thrown on. Returns OVERFLOW when the output exceeds `NER_LIMITS`.
 */
function toFindings(text: string, entities: readonly unknown[], settings: Settings): Finding[] | typeof OVERFLOW {
  if (entities.length > NER_LIMITS.maxEntities) return OVERFLOW;
  const seen = new Set<string>();
  const search = new WordSearch(text);
  let wordSpans = 0;
  const spans: Span[] = [];
  const add = (start: number, end: number, category: Category, confidence: number, prefix: Prefix): void => {
    const cleaned = cleanSpan(text, start, end);
    if (!cleaned) return;
    const value = text.slice(cleaned[0], cleaned[1]);
    // The two-letter rule applies to each piece too, so two one-letter tokens cannot merge into a "name"
    // (a single CJK/Thai character can still start a BIO chain).
    if (!withinLimits(value) || (!hasTwoLetters(value) && !ONLY_NO_SPACE.test(value))) return;
    spans.push({ start: cleaned[0], end: cleaned[1], category, confidence, prefix });
  };

  for (const raw of entities) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as NerEntity;
    if (typeof e.label !== "string") continue;
    const { base, prefix } = parseLabel(e.label);
    const category = settings.labels.get(base);
    if (category === undefined) continue;
    let confidence = UNSCORED_CONFIDENCE;
    if (e.score !== undefined) {
      if (typeof e.score !== "number" || !Number.isFinite(e.score) || e.score < settings.minScore) continue;
      confidence = Math.min(1, Math.max(0, e.score));
    }
    // Cheap checks before any normalisation: identical entities are skipped, and offsets far longer
    // than a name are ignored (they would be dropped by the size limit anyway).
    const entityKey = `${base}\u0000${prefix}\u0000${String(e.start)}\u0000${String(e.end)}\u0000${typeof e.word === "string" && e.word.length <= 2 * NER_LIMITS.maxSpanChars ? e.word : "\u0001"}`;
    if (seen.has(entityKey)) continue;
    seen.add(entityKey);
    const offsets =
      validOffsets(text, e) && e.end - e.start <= 2 * NER_LIMITS.maxSpanChars ? ([e.start, e.end] as const) : undefined;
    const keys = wordKeys(e.word);
    const offsetKey = offsets ? `o\u0000${base}\u0000${prefix}\u0000${offsets[0]}\u0000${offsets[1]}` : undefined;

    // 1. Offsets that read as the word (loosely), or offsets with no usable word.
    if (offsets && (keys === undefined || looseCompact(text.slice(offsets[0], offsets[1])) === looseCompact(e.word as string))) {
      if (offsetKey === undefined || seen.has(offsetKey)) continue;
      seen.add(offsetKey);
      add(offsets[0], offsets[1], category, confidence, prefix);
      continue;
    }
    if (keys === undefined) continue;

    // 2. Search for the word, once per (label, word) whatever the offsets (code-point offsets after an
    //    emoji make every mention's offsets disagree, and each would otherwise re-add all hits).
    const wordKey = `w\u0000${base}\u0000${prefix}\u0000${keys.join("\u0000")}`;
    const hits = search.find(keys);
    if (hits === OVERFLOW) return OVERFLOW;
    if (hits.length > 0) {
      if (seen.has(wordKey)) continue;
      seen.add(wordKey);
      wordSpans += hits.length;
      if (wordSpans > NER_LIMITS.maxWordSpans) return OVERFLOW;
      for (const [s, t] of hits) add(s, t, category, confidence, prefix);
    } else if (offsets && offsetKey !== undefined && !seen.has(offsetKey)) {
      // 3. The word is nowhere in the text (a detokenisation we can't undo): trust the offsets.
      seen.add(offsetKey);
      add(offsets[0], offsets[1], category, confidence, prefix);
    }
  }

  const emitted = new Set<string>();
  const findings: Finding[] = [];
  for (const { prefix: _prefix, ...span } of mergeContinuations(text, spans)) {
    const key = `${span.start}:${span.end}:${span.category}`;
    const value = text.slice(span.start, span.end);
    if (emitted.has(key) || !plausible(value, span.category, settings.requireCapitalized)) continue;
    emitted.add(key);
    findings.push({ ...span, value, detector: settings.name });
  }
  return findings;
}

function settingsOf(options: NerDetectorOptions): Settings {
  if (typeof options.recognize !== "function") throw new TypeError("nerDetector: `recognize` must be a function.");
  const name = options.name ?? "ner";
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("nerDetector: `name` must be a non-empty string.");
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  if (typeof minScore !== "number" || !(minScore >= 0 && minScore <= 1)) {
    throw new TypeError("nerDetector: `minScore` must be a number between 0 and 1.");
  }
  const labels = new Map<string, Category>();
  for (const [label, category] of Object.entries(options.labels ?? DEFAULT_LABELS)) {
    if (typeof category !== "string") throw new TypeError(`nerDetector: label "${label}" must map to a category string.`);
    assertValidCategory(category);
    labels.set(normalizeLabel(label), category);
  }
  if (labels.size === 0) throw new TypeError("nerDetector: `labels` must map at least one label.");
  return { name, labels, minScore, requireCapitalized: options.requireCapitalized === true };
}

function positiveOrUndefined(value: number | undefined, what: string, integer: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !(value > 0) || (integer && !Number.isInteger(value) && value !== Infinity)) {
    throw new TypeError(`nerDetector: \`${what}\` must be a positive ${integer ? "integer" : "number"}.`);
  }
  return value;
}

/**
 * Adapts a named-entity model to the `Detector` interface (ADR 0004). No model
 * ships with pii-gate: `recognize` calls yours (transformers.js, a spaCy or
 * cloud NER service, an LLM) and returns its entities.
 *
 * - A synchronous `recognize` gives a plain `Detector`, usable with `mask`.
 * - An async one gives an `AsyncDetector`: use `maskAsync`, `maskAllAsync` or
 *   `wrapAnthropic`.
 *
 * Output is validated (labels mapped, spans checked against the text, grown to
 * whole words, trimmed, implausible spans dropped) and then goes through the
 * normal pipeline: overlap resolution with regex findings, schema hints,
 * policy, propagation. A failure rejects the call by default (`onError`).
 */
export function nerDetector(options: NerDetectorOptions & { recognize: NerRecognizeSync }): Detector;
export function nerDetector(options: NerDetectorOptions): AsyncDetector;
export function nerDetector(options: NerDetectorOptions): AsyncDetector {
  const settings = settingsOf(options);
  const timeoutMs = positiveOrUndefined(options.timeoutMs, "timeoutMs", false);
  const concurrency = positiveOrUndefined(options.concurrency, "concurrency", true) ?? DEFAULT_CONCURRENCY;
  const onError = options.onError ?? "throw";
  if (onError !== "throw" && onError !== "skip") throw new TypeError('nerDetector: `onError` must be "throw" or "skip".');
  const { recognize, onFailure } = options;
  const { name } = settings;

  function fail(reason: NerFailureReason, error?: unknown): Finding[] {
    try {
      onFailure?.(error === undefined ? { detector: name, reason } : { detector: name, reason, error });
    } catch {
      // A failing observer must not change the outcome.
    }
    if (onError === "skip") return [];
    throw new NerDetectorError(name, reason);
  }

  function convert(text: string, out: unknown): Finding[] {
    if (!Array.isArray(out)) return fail("invalid-output");
    let findings: Finding[] | typeof OVERFLOW;
    try {
      findings = toFindings(text, out, settings);
    } catch {
      // Defensive: e.g. an entity whose getters throw. The error is not passed on: it may quote the text.
      return fail("invalid-output");
    }
    return findings === OVERFLOW ? fail("invalid-output") : findings;
  }

  // Slots are handed directly from a finishing call to the next waiter, so `active` never exceeds `concurrency`.
  // A timed-out call frees its slot at the timeout; whether the abandoned work stops is up to `recognize` honouring the signal.
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  async function settleAsync(text: string, pending: PromiseLike<readonly NerEntity[]>, controller: AbortController): Promise<Finding[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const TIMED_OUT = Symbol("timeout");
    const timeout =
      timeoutMs === undefined || timeoutMs === Infinity
        ? undefined
        : new Promise<typeof TIMED_OUT>((resolve) => {
            timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
          });
    let out: unknown;
    try {
      out = await (timeout ? Promise.race([pending, timeout]) : pending);
    } catch (err) {
      return fail("error", err);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (out === TIMED_OUT) {
      controller.abort();
      // The abandoned call may still reject later; swallow it so it is not an unhandled rejection.
      Promise.resolve(pending).catch(() => undefined);
      return fail("timeout");
    }
    return convert(text, out);
  }

  /** Runs with a slot held; releases it on every path. */
  function run(text: string): Finding[] | Promise<Finding[]> {
    const controller = new AbortController();
    let out: unknown;
    try {
      out = recognize(text, { signal: controller.signal });
    } catch (err) {
      release();
      return fail("error", err);
    }
    if (!isThenable<readonly NerEntity[]>(out)) {
      release();
      return convert(text, out);
    }
    return settleAsync(text, out, controller).finally(release);
  }

  return {
    name,
    categories: [...new Set(settings.labels.values())],
    detect(text: string): Finding[] | Promise<Finding[]> {
      if (active < concurrency) {
        active++;
        return run(text);
      }
      return new Promise<void>((resolve) => waiting.push(resolve)).then(() => run(text));
    },
  };
}
