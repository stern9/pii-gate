import type { Detector } from "../types.js";
import { hasCueBefore, precededByIdentifierLabel } from "./context.js";
import { regexDetector } from "./regex.js";

const SSN_CUE = /\b(?:SSN|SS#|SS\s*No|social\s+security|TIN|tax\s*id)\b[^\d\n]{0,16}$/i;

/**
 * US Social Security Numbers. Rejects area 000, 666 and 900-999, group 00
 * and serial 0000 (never issued). Undashed 9-digit runs score lower unless
 * an SSN cue precedes them, and are dropped after identifier labels.
 */
export function ssnDetector(): Detector {
  return regexDetector({
    name: "ssn",
    category: "SSN",
    rules: [
      {
        pattern: /(?<![\w-])(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}(?![\w-])/,
        confidence: 0.9,
        validate: (_v, { text, start }) => !precededByIdentifierLabel(text, start),
      },
      {
        pattern: /(?<![\w-])(?!000|666|9\d\d)\d{3}(?!00)\d{2}(?!0000)\d{4}(?![\w-])/,
        confidence: (_v, { text, start }) => (hasCueBefore(text, start, SSN_CUE) ? 0.95 : 0.6),
        validate: (_v, { text, start }) => !precededByIdentifierLabel(text, start),
      },
    ],
  });
}
