import type { Detector } from "../types.js";
import { regexDetector } from "./regex.js";

const SUFFIX =
  "(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Trail|Trl|Loop)";
const STREET_WORD = "(?:[A-Z][a-z]+|\\d{1,3}(?:st|nd|rd|th))";
const UNIT = "(?:,?[ \\t]+(?:Apt|Apartment|Unit|Suite|Ste|#)\\.?[ \\t]*#?[ \\t]*[A-Z0-9][A-Z0-9-]*)";
const CITY_STATE_ZIP = "(?:,[ \\t]*[A-Z][a-z]+(?:[ \\t]+[A-Z][a-z]+){0,2},[ \\t]*[A-Z]{2}(?:[ \\t]+\\d{5}(?:-\\d{4})?)?)";

/**
 * US street addresses: house number + 1-4 capitalised street words + suffix,
 * with optional unit and optional ", City, ST 12345" tail. Stays on one line.
 */
export function addressDetector(): Detector {
  return regexDetector({
    name: "address",
    category: "ADDRESS",
    rules: [
      {
        pattern: new RegExp(
          `(?<![\\w-])\\d{1,6}[A-Z]?(?:[ \\t]+[NSEW]\\.?)?(?:[ \\t]+${STREET_WORD}){1,4}[ \\t]+${SUFFIX}\\b(?:\\.(?=,|[ \\t]+(?:Apt|Unit|Suite|Ste|#)))?${UNIT}?${CITY_STATE_ZIP}?`,
        ),
        confidence: 0.8,
      },
    ],
  });
}
