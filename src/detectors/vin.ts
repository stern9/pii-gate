import type { Detector } from "../types.js";
import { regexDetector } from "./regex.js";

const TRANSLITERATION: Readonly<Record<string, number>> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2] as const;

function charValue(ch: string): number {
  return /\d/.test(ch) ? Number(ch) : (TRANSLITERATION[ch] ?? Number.NaN);
}

/** ISO 3779 / 49 CFR 565 check digit (position 9). North American VINs only. */
export function isValidVinCheckDigit(vin: string): boolean {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += charValue(vin.charAt(i)) * (WEIGHTS[i] ?? 0);
  const remainder = sum % 11;
  const expected = remainder === 10 ? "X" : String(remainder);
  return vin.charAt(8) === expected;
}

export interface VinDetectorOptions {
  /**
   * Default true. Non-North-American VINs often lack a valid check digit;
   * set false to accept them at lower confidence.
   */
  requireCheckDigit?: boolean;
}

export function vinDetector(options: VinDetectorOptions = {}): Detector {
  const requireCheckDigit = options.requireCheckDigit ?? true;
  return regexDetector({
    name: "vin",
    category: "VIN",
    rules: [
      {
        pattern: /(?<![A-Za-z0-9])(?=[A-HJ-NPR-Z0-9]*\d)(?=[A-HJ-NPR-Z0-9]*[A-Z])[A-HJ-NPR-Z0-9]{17}(?![A-Za-z0-9])/,
        validate: (v) => !requireCheckDigit || isValidVinCheckDigit(v),
        confidence: (v) => (isValidVinCheckDigit(v) ? 0.95 : 0.6),
      },
    ],
  });
}
