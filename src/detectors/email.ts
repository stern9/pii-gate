import type { Detector } from "../types.js";
import { regexDetector } from "./regex.js";

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";

export function emailDetector(): Detector {
  return regexDetector({
    name: "email",
    category: "EMAIL",
    rules: [
      {
        pattern: new RegExp(
          `(?<![\\w.+%-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@${LABEL}(?:\\.${LABEL})*\\.[A-Za-z]{2,24}(?![\\w-])`,
        ),
        confidence: 0.95,
      },
    ],
  });
}
