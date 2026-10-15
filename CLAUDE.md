# pii-gate — project context for Claude Code

## What this is
A TypeScript library that sits between an application and an LLM API and masks PII before the prompt leaves the process, then restores it in the response. Portfolio project by Avram Stern; insurance-flavored examples (claims notes, policy emails), generic core.

Flow: app → `mask()` (detect → typed placeholders like `{{PERSON_1}}`, originals in a per-request `Vault`) → model sees only placeholders → `unmask()` / `unmaskDeep()` restores text and tool-call inputs → audit record written (counts and token names only, never values).

## Layout
- `src/detectors/` — regex detectors (SSN, phone, email, VIN w/ check digit, credit card w/ Luhn, DOB, driver's license, US street address, cue-based person names). `Detector` interface is the extension point; `ner.ts` — `nerDetector` adapter (async or sync `recognize`, span validation, onError throw/skip, timeout; ADR 0004). `context.ts` suppresses policy/claim/account numbers that look like PII. Overlaps: longest wins, then confidence.
- `src/mask.ts` — `mask`, `maskAll` (whole-request detection before any replacement), policy (`mask | block | allow` per category), `schemaHints` for known DB values, name propagation to uncued mentions. `maskAsync`/`maskAllAsync` for `AsyncDetector`s.
- `src/unmask.ts` — exact tokens restore; mangled tokens produce warnings and are left as-is. Never guess.
- `src/vault.ts` — `InMemoryVault` (bidirectional, stable token per value per request, `toJSON` hides values). `RedisLike`/`AsyncVault` types; `hydrate` (with `allowGaps` and `counters` for store snapshots).
- `src/redis-vault.ts` — `pii-gate/redis`: `createRedisVault` (HMAC'd lookup fields, cipher required or `"plaintext"`, TTL on every write), `loadVault`/`persistVault`/`withVault` bridge to the sync pipeline. Web Crypto only, no Redis dependency (ADR 0005).
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
- Redis vault: EXPIRE before and after every value write, plus a generation check that throws `VaultExpiredError` on mismatch (it never DELs; the only DEL on the `set` path is the corruption case). The only window for PII on a key with no TTL is a crash between a write that recreated an expired key and the EXPIRE after it (ADR 0005). Field names, lookup HMACs and the cipher AAD are bound to the generation `g`; the unmasking side must always pass `generation` to `loadVault` (an explicit `undefined`/`null` means "expect no hash"; omitting the key skips the check). Never put a value or a normalized value in a field name, and never put a user identifier in `requestId`.

## Known gaps (don't "fix" silently — these are decisions)
- Uncued, lowercase names are not detected by the regex detectors; `nerDetector` (ADR 0004) covers them when the app supplies an NER model. LOC/ORG are not mapped by default.
- Address detector masks the street line only.
- Name propagation can over-mask a surname that is also a street name (`propagateNameParts: false` turns it off).
- A propagated name part reuses the full name's token, so unmask restores the full name where only the part appeared. A part shared by two detected names is ambiguous and gets its own token (no guessing).
- US formats are detected anywhere; international phones and day-first DOBs only directly after a label (unlabelled non-US formats pass through).
- Tool inputs are restored by default (`restoreToolInputs` unset = restore everything, v0.x). ADR 0002 (Accepted) added the per-tool policy, `withheld` warnings, `toolRestoredTokens` audit counts and `LITERAL` escaping of exact placeholders in input. Escaping only narrows the risk (mangled forms like `{{SSN_1}` still get through); the restore policy is the real control. Replayed assistant turns keep only tokens the vault held *before* the request (snapshot), never ones the same request allocates. Don't change the default restore behaviour without updating the ADR. `LITERAL` is a reserved category.
- Vault is per request by default; multi-turn conversations with thinking blocks or trimmed history need a conversation-scoped `createVault` (ADR 0003). Fields outside system and messages (`metadata`, `tools`, `tool_choice`) are never masked.

## Roadmap ideas
Done: Next.js demo (`demo/`, live at pii-gate.vercel.app), latency benchmark (`npm run bench`), ADR 0002 (per-tool restore policy, placeholder escaping), NER adapter (ADR 0004), Redis vault (ADR 0005).
