import type { Detector } from "../types.js";
import { precededByIdentifierLabel } from "./context.js";
import { regexDetector } from "./regex.js";

const notAnIdentifier = (_v: string, ctx: { text: string; start: number }): boolean =>
  !precededByIdentifierLabel(ctx.text, ctx.start);

const US_PHONE =
  /(?<![\w-])(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)[ .-]?|[2-9]\d{2}[ .-])[2-9]\d{2}[ .-]\d{4}(?:[ \t]*(?:x|ext\.?)[ \t]*\d{1,5})?(?![\w-])/;

/** Labels that introduce a phone number. Multi-word forms first so the longest label is consumed. */
const PHONE_LABEL =
  "\\b(?:(?:phone|telephone|tel|mobile|cell|contact)[ \\t]+(?:number|num|nbr|no\\.?)|phone|telephone|tel|mobile|cell|mob)(?![A-Za-z])";

/** A date starting the next space-separated group ("phone 555 0123 2024-06-01"): stop before it. */
const DATE_AHEAD = "(?:\\d{4}[-./]\\d{1,2}[-./]\\d{1,2}|\\d{1,2}[-./]\\d{1,2}[-./]\\d{2,4})(?!\\d)";
const AREA = "\\(\\d{1,5}\\)";
const SEP = `(?:[ .-]?${AREA}[ .-]?|[.-]|[ ](?!${DATE_AHEAD}))`;

/**
 * Cue-gated international/free-form number: label, optional `:`/`#`/`.`/`-` and
 * "is", then an optional `+`, digit groups joined by a single space, dash or
 * dot, or a parenthesised area code. Never crosses a newline.
 */
const LABELLED_PHONE = new RegExp(
  `${PHONE_LABEL}[ \\t]*(?:[:#.=-][ \\t]*){0,2}(?:is[ \\t]+)?(?<value>\\+?(?:${AREA}[ .-]?)?\\d+(?:${SEP}\\d+)*)(?![\\w/])(?!-\\w)`,
  "i",
);

const DATE_SHAPED = /^(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4})$/;

function plausibleLabelledNumber(value: string, ctx: { text: string; start: number }): boolean {
  const digits = value.replace(/\D/g, "").length;
  if (digits < 7 || digits > 15) return false;
  if (DATE_SHAPED.test(value)) return false;
  // US-shaped numbers belong to the US rule; reporting both would duplicate the finding.
  if (US_PHONE.test(value)) return false;
  return notAnIdentifier(value, ctx);
}

/**
 * Phone numbers. US/NANP numbers are found anywhere: they need separators (or
 * a phone cue for bare 10-digit runs) and NANP-valid area/exchange codes.
 * Other formats (international, short local numbers) are accepted only
 * directly after a phone label. Numbers labelled as policy/claim/account
 * identifiers are skipped.
 */
export function phoneDetector(): Detector {
  return regexDetector({
    name: "phone",
    category: "PHONE",
    rules: [
      {
        pattern: US_PHONE,
        confidence: 0.85,
        validate: notAnIdentifier,
      },
      {
        pattern:
          /\b(?:phone|tel|cell|mobile|fax|ph)\b[^\d\n]{0,12}?(?<value>(?:\+?1)?[2-9]\d{2}[2-9]\d{6})(?![\w-])/i,
        confidence: 0.8,
      },
      {
        pattern: LABELLED_PHONE,
        confidence: 0.6,
        validate: plausibleLabelledNumber,
      },
    ],
  });
}
