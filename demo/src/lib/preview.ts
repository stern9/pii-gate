import { PiiBlockedError, detect, mask, type Finding, type MaskFinding, type Policy } from "pii-gate/core";

/** One piece of the masked preview, positioned against the original note. */
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "token"; text: string; category: string }
  | { kind: "allow"; text: string; category: string }
  | { kind: "kept"; text: string };

export type Preview = {
  kind: "masked" | "blocked";
  segments: Segment[];
  counts: Record<string, number>;
  /** Detected categories whose policy is "allow" (sent in clear text). */
  allowed: string[];
  /** Categories that block the request (empty unless kind is "blocked"). */
  blocked: string[];
  hasKept: boolean;
};

/** Digit runs that could be a phone, SSN or card number once read without their surroundings. */
const NUMBER_RUN = /[(+]?\d[\d ().-]{5,}\d/g;

/**
 * Numbers that a detector flags on their own but that were not masked in
 * context: identifier-labelled numbers ("Policy No. 512-555-0147"), which
 * pii-gate leaves alone on purpose. Uses only the public `detect`.
 */
function keptSpans(text: string, findings: readonly Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const m of text.matchAll(NUMBER_RUN)) {
    const start = m.index;
    const end = start + m[0].length;
    if (findings.some((f) => f.start < end && start < f.end)) continue;
    for (const f of detect(m[0])) out.push({ ...f, start: start + f.start, end: start + f.end });
  }
  return out;
}

function segments(text: string, findings: readonly MaskFinding[], kept: readonly Finding[]): Segment[] {
  const spans = [...findings, ...kept.map((k) => ({ ...k, action: "kept" as const }))].sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;
    if (s.start > cursor) out.push({ kind: "text", text: text.slice(cursor, s.start) });
    if (s.action === "kept") out.push({ kind: "kept", text: s.value });
    else if (s.action === "allow" || !s.token) out.push({ kind: "allow", text: s.value, category: s.category });
    else out.push({ kind: "token", text: s.token, category: s.category });
    cursor = s.end;
  }
  if (cursor < text.length) out.push({ kind: "text", text: text.slice(cursor) });
  return out;
}

/** Live preview of the masking step, run in the browser on every keystroke. */
export function preview(text: string, policy: Policy): Preview {
  const counts: Record<string, number> = {};
  for (const f of mask(text).findings) counts[f.category] = (counts[f.category] ?? 0) + 1;
  const allowed = Object.keys(counts).filter((c) => policy[c] === "allow");
  let result;
  let blocked: string[] = [];
  try {
    result = mask(text, { policy });
  } catch (err) {
    if (!(err instanceof PiiBlockedError)) throw err;
    // Still show what masking would have produced, dimmed, so the block reads as a decision, not a crash.
    blocked = err.categories;
    const asMask = Object.fromEntries(Object.entries(policy).map(([c, a]) => [c, a === "block" ? "mask" : a]));
    result = mask(text, { policy: asMask });
  }
  const kept = keptSpans(text, result.findings);
  return {
    kind: blocked.length > 0 ? "blocked" : "masked",
    segments: segments(text, result.findings, kept),
    counts,
    allowed,
    blocked,
    hasKept: kept.length > 0,
  };
}
