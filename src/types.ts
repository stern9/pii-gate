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

const CATEGORY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function assertValidCategory(category: string): void {
  if (!CATEGORY_PATTERN.test(category)) {
    throw new TypeError(
      `Invalid PII category "${category}": categories must be UPPER_SNAKE_CASE so placeholders stay parseable.`,
    );
  }
}
