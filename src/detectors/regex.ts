import type { Category, Detector, Finding } from "../types.js";

export interface RegexRule {
  /**
   * Must be a pattern whose match (or named group `value`, if present) is the
   * PII span. Global and `d` (indices) flags are added automatically.
   */
  pattern: RegExp;
  confidence: number | ((value: string, ctx: MatchContext) => number);
  /** Return false to drop a candidate (checksum failed, negative cue, ...). */
  validate?: (value: string, ctx: MatchContext) => boolean;
}

export interface MatchContext {
  text: string;
  start: number;
  end: number;
  match: RegExpExecArray;
}

export interface RegexDetectorSpec {
  name: string;
  category: Category;
  rules: readonly RegexRule[];
}

function withFlags(pattern: RegExp, required: string): RegExp {
  const flags = new Set([...pattern.flags, ...required]);
  return new RegExp(pattern.source, [...flags].join(""));
}

function spanOf(match: RegExpExecArray): [number, number] | undefined {
  const indices = match.indices;
  const span = indices?.groups?.["value"] ?? indices?.[0];
  return span ? [span[0], span[1]] : undefined;
}

/** Builds a Detector from one or more regex rules for a single category. */
export function regexDetector(spec: RegexDetectorSpec): Detector {
  const compiled = spec.rules.map((rule) => ({ ...rule, pattern: withFlags(rule.pattern, "gd") }));
  return {
    name: spec.name,
    categories: [spec.category],
    detect(text: string): Finding[] {
      // Keyed by span so overlapping rules don't report the same span twice.
      const bySpan = new Map<string, Finding>();
      for (const rule of compiled) {
        for (const match of text.matchAll(rule.pattern)) {
          const span = spanOf(match);
          if (!span || span[0] === span[1]) continue;
          const [start, end] = span;
          const value = text.slice(start, end);
          const ctx: MatchContext = { text, start, end, match };
          if (rule.validate && !rule.validate(value, ctx)) continue;
          const confidence =
            typeof rule.confidence === "function" ? rule.confidence(value, ctx) : rule.confidence;
          const key = `${start}:${end}`;
          const prev = bySpan.get(key);
          if (!prev || prev.confidence < confidence) {
            bySpan.set(key, { category: spec.category, start, end, value, confidence, detector: spec.name });
          }
        }
      }
      return [...bySpan.values()].sort((a, b) => a.start - b.start);
    },
  };
}
