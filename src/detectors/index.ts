import type { Category, Detector, Finding } from "../types.js";
import { addressDetector } from "./address.js";
import { creditCardDetector } from "./credit-card.js";
import { dobDetector } from "./dob.js";
import { driversLicenseDetector } from "./drivers-license.js";
import { emailDetector } from "./email.js";
import { personDetector } from "./person.js";
import { phoneDetector } from "./phone.js";
import { ssnDetector } from "./ssn.js";
import { vinDetector } from "./vin.js";

export { addressDetector } from "./address.js";
export { creditCardDetector, luhnValid } from "./credit-card.js";
export { dobDetector } from "./dob.js";
export { driversLicenseDetector } from "./drivers-license.js";
export { emailDetector } from "./email.js";
export { personDetector } from "./person.js";
export { phoneDetector } from "./phone.js";
export { regexDetector, type RegexDetectorSpec, type RegexRule, type MatchContext } from "./regex.js";
export { ssnDetector } from "./ssn.js";
export { isValidVinCheckDigit, vinDetector, type VinDetectorOptions } from "./vin.js";
export {
  NerDetectorError,
  nerDetector,
  type NerDetectorOptions,
  type NerEntity,
  type NerFailure,
  type NerFailureReason,
  type NerRecognize,
  type NerRecognizeContext,
  type NerRecognizeSync,
} from "./ner.js";

export function defaultDetectors(): Detector[] {
  return [
    ssnDetector(),
    phoneDetector(),
    emailDetector(),
    vinDetector(),
    creditCardDetector(),
    dobDetector(),
    driversLicenseDetector(),
    addressDetector(),
    personDetector(),
  ];
}

/**
 * Wraps precomputed spans (e.g. from an async NER call) as a Detector so they
 * flow through the same overlap resolution as everything else.
 */
export function staticDetector(name: string, findings: readonly Finding[]): Detector {
  const categories = [...new Set(findings.map((f) => f.category))];
  return {
    name,
    categories,
    detect: (text) =>
      findings
        .filter((f) => text.slice(f.start, f.end) === f.value)
        .map((f) => ({ ...f, detector: f.detector ?? name })),
  };
}

function compareForPriority(a: Finding, b: Finding): number {
  const lengthDiff = b.end - b.start - (a.end - a.start);
  if (lengthDiff !== 0) return lengthDiff;
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  return a.start - b.start;
}

/**
 * Greedy overlap resolution: longest span wins, ties go to higher
 * confidence, then earlier start. Returns non-overlapping findings sorted by
 * position.
 */
export function resolveOverlaps(findings: readonly Finding[]): Finding[] {
  const kept: Finding[] = [];
  for (const candidate of [...findings].sort(compareForPriority)) {
    const overlaps = kept.some((k) => candidate.start < k.end && k.start < candidate.end);
    if (!overlaps) kept.push(candidate);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * The output of a synchronous detector, or a TypeError naming the detector
 * (configuration, never input text) when it returned a promise or anything else.
 * @internal
 */
export function findingsOf(detector: { readonly name: string }, out: unknown): Finding[] {
  if (Array.isArray(out)) return out as Finding[];
  throw new TypeError(
    `Detector "${detector.name}" did not return an array of findings. Async detectors (e.g. nerDetector) need maskAsync, maskAllAsync or wrapAnthropic.`,
  );
}

export interface DetectOptions {
  detectors?: readonly Detector[];
  /** Findings below this confidence are discarded before overlap resolution. Default 0.5. */
  minConfidence?: number;
}

export function detect(text: string, options: DetectOptions = {}): Finding[] {
  const detectors = options.detectors ?? defaultDetectors();
  const minConfidence = options.minConfidence ?? 0.5;
  const raw = detectors.flatMap((d) => findingsOf(d, d.detect(text))).filter((f) => f.confidence >= minConfidence);
  return resolveOverlaps(raw);
}

export function categoriesOf(detectors: readonly Detector[]): Category[] {
  return [...new Set(detectors.flatMap((d) => d.categories))];
}
