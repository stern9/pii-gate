import type { Detector } from "../types.js";
import { regexDetector } from "./regex.js";

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** How cards are printed: 4-4-4-4, Amex 4-6-5, Diners 4-6-4, 19-digit 4-4-4-4-3. */
const GROUPINGS = new Set(["4,4,4,4", "4,6,5", "4,6,4", "4,4,4,4,3"]);

/**
 * Either one unbroken run of digits, or a known grouping with a single kind of
 * separator. Rejects runs of unrelated numbers that happen to pass Luhn, such
 * as "55501234 2024-06-01".
 */
function cardShaped(v: string): boolean {
  const separators = new Set(v.match(/[ -]/g) ?? []);
  if (separators.size === 0) return true;
  if (separators.size > 1) return false;
  return GROUPINGS.has(v.split(/[ -]/).map((g) => g.length).join(","));
}

/**
 * Payment card numbers: 13-19 digits, unbroken or in a standard grouping,
 * leading digit 2-6 (major networks), Luhn-valid.
 */
export function creditCardDetector(): Detector {
  return regexDetector({
    name: "credit-card",
    category: "CREDIT_CARD",
    rules: [
      {
        pattern: /(?<![\w-])[2-6](?:[ -]?\d){12,18}(?![\w-])/,
        validate: (v) => {
          const digits = v.replace(/[ -]/g, "");
          return digits.length >= 13 && digits.length <= 19 && cardShaped(v) && luhnValid(digits);
        },
        confidence: 0.95,
      },
    ],
  });
}
