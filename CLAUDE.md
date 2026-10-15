# pii-gate — project context for Claude Code

## What this is
A TypeScript library that sits between an application and an LLM API and masks PII before the prompt leaves the process, then restores it in the response. Portfolio project by Avram Stern; insurance-flavored examples (claims notes, policy emails), generic core.

Flow: app → `mask()` (detect → typed placeholders like `{{PERSON_1}}`, originals in a per-request `Vault`) → model sees only placeholders → `unmask()` / `unmaskDeep()` restores text and tool-call inputs → audit record written (counts and token names only, never values).

## Layout
- `src/detectors/` — regex detectors (SSN, phone, email, VIN w/ check digit, credit card w/ Luhn, DOB, driver's license, US street address, cue-based person names). `Detector` interface is the extension point for NER. `context.ts` suppresses policy/claim/account numbers that look like PII. Overlaps: longest wins, then confidence.
- `src/mask.ts` — `mask`, `maskAll` (whole-request detection before any replacement), policy (`mask | block | allow` per category), `schemaHints` for known DB values, name propagation to uncued mentions.
- `src/unmask.ts` — exact tokens restore; mangled tokens produce warnings and are left as-is. Never guess.
- `src/vault.ts` — `InMemoryVault` (bidirectional, stable token per value per request, `toJSON` hides values). Redis vault is a documented contract only.
- `src/anthropic.ts` — `wrapAnthropic(client)` structural wrapper; masks system/messages/tool_results, unmasks text and `tool_use.input`. Non-streaming only; images/PDFs throw unless `unsupportedContent: "passthrough"`.
- `src/audit.ts` — `JsonlAuditLogger`, `MemoryAuditLogger`.
- `test/` — vitest; `test/fixtures/*.json` golden set with fake PII.
- `docs/adr/` — architecture decision records.

## Commands
`npm install` · `npm test` · `npm run typecheck` · `npm run build` · `npm run example`

## Rules
- Strict TS, no `any` in public API, zero runtime deps in core. Anthropic SDK stays an optional peer; type against the structural interfaces in `anthropic.ts`.
- Never log, print, or put in an error message a raw PII value — including in tests, warnings, and audit records.
- Fixtures use fake PII only (SSNs in invalid ranges are fine for negatives; valid-shaped ones must be clearly fabricated).
- Prefer precision over recall in regex detectors; document misses in README "Limitations" rather than loosening patterns.
- Any new detector needs: unit tests with true positives and tricky negatives, a golden fixture line, and a README mention.
- Name detector is Unicode-aware (`\p{Lu}`/`\p{Ll}`, `u` flag) — keep it that way; accented names are common in production.

## Known gaps (don't "fix" silently — these are decisions)
- Uncued, lowercase names are not detected (needs NER).
- Address detector masks the street line only.
- Name propagation can over-mask a surname that is also a street name (`propagateNameParts: false` turns it off).
- US formats are detected anywhere; international phones and day-first DOBs only directly after a label (unlabelled non-US formats pass through).

## Roadmap ideas
Next.js demo page (paste note → masked / restored / audit row), latency benchmark on a ~2 KB note, optional NER detector adapter, Redis vault implementation.
