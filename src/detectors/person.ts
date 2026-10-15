import type { Detector } from "../types.js";
import { ci } from "./context.js";
import { regexDetector } from "./regex.js";

/** Capitalised words that commonly follow a name in structured notes and must not be absorbed into it. */
const STOP_WORDS = [
  "Policy", "Claim", "Claims", "Date", "Dob", "DOB", "Phone", "Email", "Address", "Vehicle", "Vin", "VIN",
  "Mr", "Mrs", "Ms", "Miss", "Mx", "Dr", "Notes", "Note", "Status", "Adjuster", "Insured", "Claimant", "Agent", "The", "And", "Re", "Subject",
  "Loss", "Coverage", "Premium", "Effective", "Thanks", "Regards", "Hi", "Hello", "Dear", "Called",
  "Reported", "Said", "Stated", "Was", "Is", "Has", "Had", "On", "At", "In", "For", "From", "To", "Per",
];

// Unicode-aware so accented and non-ASCII names (María, Müller, Łukasz) are whole words.
const UPPER = "\\p{Lu}";
const LOWER = "\\p{Ll}+";
const WORD_CORE = `(?:${UPPER}${LOWER}(?:${UPPER}${LOWER})?|${UPPER}['’]${UPPER}${LOWER})(?:-${UPPER}${LOWER})?`;
// A name word: not a stop word, and not a field label ("Phone:").
const WORD = `(?!(?:${STOP_WORDS.join("|")})\\b)(?![\\p{L}'’-]+[ \\t]*:)${WORD_CORE}`;
const INITIAL = `${UPPER}\\.`;
const SPACE = "[ \\t]+";
// A single line break is allowed only after the first word, which covers
// "Claimant: Maria\nGonzalez" without letting a name swallow the next line.
const NAME = `(?<value>${WORD}(?:(?:${SPACE}|[ \\t]*\\r?\\n[ \\t]*)(?:${WORD}|${INITIAL}))?(?:${SPACE}(?:${WORD}|${INITIAL})){0,2}(?<!\\.))`;

const LABELS = [
  "named insured", "insured", "claimant", "policyholder", "policy holder", "name", "driver", "beneficiary",
  "applicant", "witness", "patient", "attn", "contact", "insured name", "claimant name",
];
const LABEL_CUE = `\\b(?:${LABELS.map((l) => l.split(" ").map(ci).join("[ \\t]+")).join("|")})[ \\t]*:[ \\t]*`;
const TITLE_CUE = "\\b(?:Mr|Mrs|Ms|Miss|Mx|Dr)\\.?[ \\t]+";

/**
 * Cue-driven person names. Deliberately conservative: an uncued name
 * ("spoke with Maria") is NOT detected here. Pair with an NER detector or
 * `schemaHints` for real coverage; `mask()` also propagates detected names
 * to their other occurrences.
 */
export function personDetector(): Detector {
  return regexDetector({
    name: "person",
    category: "PERSON",
    rules: [
      { pattern: new RegExp(`${LABEL_CUE}(?:${TITLE_CUE})?${NAME}`, "u"), confidence: 0.85 },
      { pattern: new RegExp(`${TITLE_CUE}${NAME}`, "u"), confidence: 0.8 },
    ],
  });
}

export const PERSON_STOP_WORDS: ReadonlySet<string> = new Set(STOP_WORDS);
