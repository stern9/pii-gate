/**
 * Labels that, when they immediately precede a number, mean the number is a
 * business identifier rather than personal data ("Policy No. 512-555-0147").
 */
const IDENTIFIER_LABEL =
  /\b(?:policy|pol|claim|clm|account|acct|reference|ref|invoice|inv|member|group|grp|loan|quote|certificate|cert|case|ticket|order)\b[\s.]*(?:no\.?|number|num|nbr|#|id)?[\s.]*[:#=]?\s*$/i;

/** True if the ~32 characters before `start` end with an identifier label. */
export function precededByIdentifierLabel(text: string, start: number, window = 32): boolean {
  const before = text.slice(Math.max(0, start - window), start);
  return IDENTIFIER_LABEL.test(before);
}

/** True if a cue regex matches within `window` characters before `start`. */
export function hasCueBefore(text: string, start: number, cue: RegExp, window = 24): boolean {
  return cue.test(text.slice(Math.max(0, start - window), start));
}

/** Case-insensitive alternation for a word, usable inside an otherwise case-sensitive regex. */
export function ci(word: string): string {
  return [...word]
    .map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toUpperCase()}${ch.toLowerCase()}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
}
