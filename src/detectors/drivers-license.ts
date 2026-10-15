import type { Detector } from "../types.js";
import { regexDetector } from "./regex.js";

const CUE =
  "\\b(?:DL|D\\.L\\.|DLN|driver['’]?s?\\s+licen[cs]e|licen[cs]e)(?:\\s*(?:#|no\\.?|number|num|nbr))?(?![A-Za-z])";

/**
 * US driver's license numbers. Formats vary by state (1-2 letters + digits,
 * all digits, etc.), so the value is accepted only after a license cue and
 * must contain at least one digit.
 */
export function driversLicenseDetector(): Detector {
  return regexDetector({
    name: "drivers-license",
    category: "DRIVERS_LICENSE",
    rules: [
      {
        pattern: new RegExp(
          `${CUE}(?:\\s*\\([A-Z]{2}\\))?[\\t ]*[:#]?[\\t ]*(?:is[\\t ]+)?(?<value>[A-Z0-9][A-Z0-9-]{3,16}[A-Z0-9])(?![\\w-])`,
          "i",
        ),
        validate: (v) => /\d/.test(v) && /^[A-Z0-9-]+$/.test(v),
        confidence: 0.85,
      },
    ],
  });
}
