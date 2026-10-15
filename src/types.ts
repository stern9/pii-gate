/**
 * Built-in categories. Custom detectors may emit any UPPER_SNAKE_CASE category;
 * the `(string & {})` member keeps autocomplete for the built-ins without
 * closing the union.
 */
export type BuiltInCategory =
  | "PERSON"
  | "SSN"
  | "PHONE"
  | "EMAIL"
  | "VIN"
  | "CREDIT_CARD"
  | "DOB"
  | "DRIVERS_LICENSE"
  | "ADDRESS";

export type Category = BuiltInCategory | (string & {});

export const BUILT_IN_CATEGORIES: readonly BuiltInCategory[] = [
  "PERSON",
  "SSN",
  "PHONE",
  "EMAIL",
  "VIN",
  "CREDIT_CARD",
  "DOB",
  "DRIVERS_LICENSE",
  "ADDRESS",
];

/** A single detected span. `end` is exclusive, like String.prototype.slice. */
export interface Finding {
  category: Category;
  start: number;
  end: number;
  value: string;
  /** 0..1. Used for tie-breaking overlaps and the `minConfidence` cutoff. */
  confidence: number;
  /** Name of the detector that produced the finding (for debugging, never logged with the value). */
  detector?: string;
}

/**
 * Pluggable detector. Built-ins are regex-based; an NER model, a cloud DLP
 * service or a dictionary lookup can implement the same shape.
 *
 * Detectors are synchronous so `mask()` can stay synchronous. For an async
 * detector (remote NER), run it first and feed the results in through
 * `staticDetector()`.
 */
export interface Detector {
  readonly name: string;
  readonly categories: readonly Category[];
  detect(text: string): Finding[];
}

export type PolicyAction = "mask" | "block" | "allow";

export type Policy = Partial<Record<Category, PolicyAction>>;

/** JSON value shape used by `unmaskDeep` and tool-call payloads. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A record with no prototype, for maps keyed by names that come from model
 * output or configuration (tool names, categories). A key like `__proto__` or
 * `constructor` is then an ordinary own property and cannot reach
 * `Object.prototype`.
 */
export function nullRecord<V>(): Record<string, V> {
  return Object.create(null) as Record<string, V>;
}

/** Adds `n` to `counts[key]` as an own property. */
export function addCount(counts: Record<string, number>, key: string, n = 1): void {
  counts[key] = (Object.hasOwn(counts, key) ? (counts[key] ?? 0) : 0) + n;
}

const CATEGORY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Reserved category for placeholder-shaped text that was already in the input
 * (e.g. a `{{SSN_1}}` planted in a document). It is masked to `{{LITERAL_n}}`
 * and restored to the same literal text, never to a vault value. Schema hints
 * and detectors cannot use it.
 */
export const LITERAL_CATEGORY = "LITERAL";

const RESERVED_CATEGORIES: ReadonlySet<string> = new Set([LITERAL_CATEGORY]);

export function assertValidCategory(category: string): void {
  if (!CATEGORY_PATTERN.test(category)) {
    throw new TypeError(
      `Invalid PII category "${category}": categories must be UPPER_SNAKE_CASE so placeholders stay parseable.`,
    );
  }
  if (RESERVED_CATEGORIES.has(category)) {
    throw new TypeError(
      `Invalid PII category "${category}": it is reserved by pii-gate for escaped placeholder text and cannot be used by schema hints or detectors.`,
    );
  }
}
