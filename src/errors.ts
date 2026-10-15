import type { Category } from "./types.js";

/**
 * Thrown when text contains a category whose policy is "block".
 * Carries categories and counts only — never the matched values.
 */
export class PiiBlockedError extends Error {
  override readonly name = "PiiBlockedError";
  readonly categories: Category[];
  readonly counts: Readonly<Record<string, number>>;

  constructor(counts: Record<string, number>) {
    const categories = Object.keys(counts).sort();
    super(`Blocked: input contains PII in blocked categories: ${categories.join(", ")}`);
    this.categories = categories;
    this.counts = Object.freeze({ ...counts });
  }
}

/** Thrown by the Anthropic wrapper for content it cannot inspect (images, PDFs, streaming). */
export class UnsupportedContentError extends Error {
  override readonly name = "UnsupportedContentError";
  constructor(readonly what: string) {
    super(`pii-gate cannot inspect ${what}; refusing to forward it unmasked. Set unsupportedContent: "passthrough" to override.`);
  }
}

/**
 * An internal consistency check failed (for example, request params changed
 * between the wrapper's two traversals). Nothing was sent. Carries counts only.
 */
export class PiiGateInvariantError extends Error {
  override readonly name = "PiiGateInvariantError";
}
