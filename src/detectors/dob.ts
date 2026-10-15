import type { Detector } from "../types.js";
import { regexDetector } from "./regex.js";

const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const MM = "(?:0?[1-9]|1[0-2])";
const DD = "(?:0?[1-9]|[12]\\d|3[01])";
const YEAR = "(?:19|20)\\d{2}";
const DATE = [
  `${MM}(?<sep>[/.-])${DD}\\k<sep>(?:${YEAR}|\\d{2})`, // 03/14/1979, 3-14-79
  // Day-first (15/02/1988, 15.02.88). Only reachable behind the birth cue, so
  // the order ambiguity doesn't matter: either way it is a date of birth.
  `${DD}(?<sep2>[/.-])${MM}\\k<sep2>(?:${YEAR}|\\d{2})`,
  `${YEAR}-${MM}-${DD}`, // 1979-03-14
  `${MONTH}\\s+${DD}(?:st|nd|rd|th)?,?\\s+${YEAR}`, // March 14, 1979
  `${DD}(?:st|nd|rd|th)?\\s+${MONTH},?\\s+${YEAR}`, // 14 March 1979
].join("|");

const CUE = "\\b(?:DOB|D\\.O\\.B\\.?|date\\s+of\\s+birth|birth\\s*date|birthday|born)";

/**
 * Dates of birth. A date alone is not PII-specific (loss dates, effective
 * dates), so a birth cue must appear within ~20 characters before it, with
 * no sentence break or other digits in between. Behind the cue, both
 * month-first and day-first numeric dates are accepted.
 */
export function dobDetector(): Detector {
  return regexDetector({
    name: "dob",
    category: "DOB",
    rules: [
      {
        pattern: new RegExp(`${CUE}(?![A-Za-z])[^\\n\\d;!?]{0,20}?(?<value>${DATE})(?![\\w/-])`, "i"),
        confidence: 0.9,
        // The lazy filler may not swallow a sentence-ending period ("DOB: unknown. Loss 03/02/2024").
        validate: (_v, { match }) => {
          const filler = match[0].slice(0, match[0].length - (match.groups?.["value"]?.length ?? 0));
          return !/\.\s+[A-Z]/.test(filler.replace(/^D\.O\.B\./i, ""));
        },
      },
    ],
  });
}
