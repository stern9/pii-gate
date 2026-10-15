# ADR 0003: Vault scope across a conversation, and request fields the wrapper doesn't mask

- Status: Accepted
- Date: 2026-10-14

## Context

### Placeholder numbering across turns

By default `wrapAnthropic` creates a fresh `InMemoryVault` for every `messages.create`. `maskAll` hands out numbers in first-occurrence order across the strings it visits (every message in order, then the system prompt). The Messages API is stateless, so the application resends the whole history each turn, already unmasked, and the wrapper masks it again from scratch.

Numbering is usually the same from turn to turn because the history is a stable prefix. That isn't guaranteed. Any of these changes it:

- a value that first appears earlier in the request: the application trims or summarises old turns, or edits the system prompt;
- different `schemaHints` on a later turn, which make a value in an old message detectable;
- propagation: a name that is cued for the first time in a later turn is now also masked where it appeared uncued in an old turn.

Re-masked text and `tool_use.input` don't care, because they're masked again with the new numbers. Two things do:

- **`thinking` and `redacted_thinking` blocks.** The model wrote them while reading placeholders, the wrapper doesn't unmask them, and their signatures forbid edits, so they are resent exactly as they were. They keep the old numbers.
- **Prompt caching.** Cache hits need a byte-identical prefix. When numbering shifts, every message after the first changed token is different.

A concrete case, all fake:

```text
Turn 1, user:      "Maria at the body shop confirmed the estimate. Claimant: Robert Chen wants an update."
  masked:          "Maria at the body shop ... Claimant: {{PERSON_1}} wants an update."   (uncued "Maria" isn't detected)
  thinking block:  "{{PERSON_1}} is the claimant. Draft an update to {{PERSON_1}}."

Turn 2, user:      "Shop contact is Ms. Maria Alvarez."
  re-masked:       "{{PERSON_1}} at the body shop ... Claimant: {{PERSON_2}} wants an update."
                   "Shop contact is Ms. {{PERSON_1}}."
  thinking block:  unchanged, still "{{PERSON_1}} is the claimant."
```

Propagation now masks "Maria" in turn 1, and it comes before Robert Chen, so Maria Alvarez becomes `{{PERSON_1}}`. The model's own earlier reasoning now says the shop contact is the claimant. If it copies that token into its answer ("I'll send {{PERSON_1}} the claim update"), `unmask` restores it as "Maria Alvarez". That isn't a leak to the provider. It is a wrong-person error in a claims workflow, and nothing warns about it.

ADR 0002 adds two rules that depend on vault scope. `LITERAL` escaping applies to placeholder-shaped text from users and tools. Replayed assistant turns are exempt only for exact tokens "the current vault already holds". With a per-request vault, "already holds" has to mean *issued before this request started*. If the check ran after this request's own allocation, a withheld `{{PERSON_1}}` from turn 1 would match the new `{{PERSON_1}}` and bind to whoever holds that number now, which is the same mis-binding as above. With that reading, the default vault holds nothing beforehand, every placeholder in history becomes a literal, and withheld tokens lose their link to the value (as ADR 0002 says). Thinking blocks can't be escaped at all, so they are the one place where old tokens reach the model unchanged.

### Request fields outside `system` and `messages`

`mapParams` copies every other top-level parameter unchanged: `metadata.user_id`, `tools` (names, descriptions, `input_schema`, including `enum` values), `tool_choice`, `stop_sequences`, MCP and container settings, and any field added in a future API version. Inside blocks, only the text-bearing fields are masked: `text`, `tool_use.input`, `tool_result` content and text `document` sources. Fields such as a document's `title` and `context`, or `citations[].cited_text` on replayed assistant text, pass through as they are.

These fields are normally written by developers, not supplied by users. They are configuration, and masking them would break things: a masked tool name can't be dispatched, and a masked enum no longer matches its schema. The risk is that some applications build them from customer data anyway. Examples include `metadata.user_id: "robert.chen@example.com"`, a tool description such as "Look up policies for Robert Chen", or an `enum` of claimant names loaded from the database. All of these reach the provider in clear text and nothing is recorded in the audit log.

## Options (numbering)

**(a) Document only.** Explain the behaviour and leave it as it is. This works for applications that don't resend thinking blocks and don't trim history. It doesn't help those that do.

**(b) Conversation-scoped vault through `createVault`.** This is already supported, so no code is needed. Tokens issued on turn 1 keep their numbers for the whole conversation. Re-masked history is byte-identical, thinking blocks stay correct, and withheld tokens under ADR 0002 keep their link. Values from earlier turns also seed propagation through `vault.entries()`, so a name from turn 1 is still masked in turn 5 even without a cue. The costs:
  - *Lifetime.* Originals live as long as the conversation, not one round trip. That goes beyond the guidance in the `Vault` doc comment (one round trip or tool loop, TTL in minutes). The application already stores the same history unmasked, so a vault kept under the same retention and access controls adds little exposure. A vault kept with weaker controls (a debug cache, a log) adds real exposure. Set the TTL to the conversation's idle timeout and call `clear()` when the conversation ends.
  - *Memory and distribution.* An `InMemoryVault` grows with the conversation and doesn't survive a process restart or a move to another instance. A persistent store keeps raw values (`entries()` → `hydrate`), so it needs encryption at rest, as the `AsyncVault` contract already requires.
  - *Isolation.* One vault per conversation, never per user across conversations and never shared. A shared vault would let a planted or copied token from one conversation be restored with another's value.
  - *Plumbing.* `createVault` takes no arguments, so the application either wraps the client per conversation or reads the conversation id from request context (for example `AsyncLocalStorage`).
  - *Spelling and over-masking.* The first spelling seen applies to the whole conversation, and name-part over-masking (a surname that is also a street name) builds up across turns.

**(c) Deterministic numbering.** *Sorted order* (number values alphabetically, say) doesn't work, because any new value shifts the numbers of the ones after it. *Content-derived tokens* such as `{{PERSON_k3f9}}` from an HMAC of category and value under a per-conversation key do give stable tokens with no stored originals. A token whose value is no longer in the request becomes an unknown-token warning instead of a wrong person. The costs are a new token format (the `_\d+` shape is assumed by unmask, `hydrate` and ADR 0002's escaping), collision handling after truncation, a per-conversation key that must itself be stored, and less readable prompts. A plain unkeyed hash is out of the question: SSNs and DOBs are low-entropy and can be brute-forced. This is worth reconsidering if (b) turns out to be impractical to run, but it isn't justified yet.

**(d) Strip thinking blocks from history.** This removes the stale tokens, but the model loses its reasoning from earlier turns. Some models and features (extended thinking with tool use in the same assistant turn) require the thinking blocks of the current tool loop to be sent back, so the library can't strip them by default. Applications may drop thinking from *completed* earlier turns where the API allows it.

## Decision

1. **Keep the per-request vault as the default.** It holds originals for the shortest time, and it is correct for single calls and for conversations without thinking blocks or history trimming.
2. **Recommend a conversation-scoped vault (b)** in the README for any multi-turn conversation that resends `thinking` blocks, trims or summarises history, depends on prompt-cache hits, or uses ADR 0002's withheld tokens. Document the lifetime, isolation and TTL rules from option (b), and widen the `Vault` doc comment from "one round trip" to "one round trip, tool loop, or conversation, never across conversations or users".
3. **Pin down ADR 0002's history exemption.** "A token the vault already holds" means a token that existed before this request started allocating. Whoever implements ADR 0002 (e) should snapshot the vault's tokens before masking and add a test for the stale-token case above.
4. **Don't change the token format (c) or strip thinking blocks (d)** in the library. (d) is the application's decision.
5. **Fields outside `system` and `messages` stay unmasked by design.** The README states it, and recommends opaque identifiers: a random or HMAC'd `metadata.user_id`, and tool descriptions and schemas that hold no customer data, which should go in messages instead. A future opt-in check, for example `scanPassthroughFields: "warn" | "block"` running the detectors over those strings and reporting category counts, is a possible follow-up. It isn't part of this decision.

No code changes, so this ADR is Accepted.

## Consequences

- **The default can still give the wrong person** in conversations with thinking blocks whose numbering shifts. That gap is documented, not closed. Applications that follow the recommendation in (2) avoid it.
- **A conversation vault widens what history can restore.** Under ADR 0002, an exact token in a replayed assistant turn is restored if the vault holds it. If the client sends the history (a browser chat that posts the full transcript), assistant turns are attacker-controlled, and with a conversation vault they can name any value from the whole conversation, including turns already trimmed. Such applications should keep history on the server.
- **Prompt caching improves** with a conversation vault, because re-masked history is byte-identical as long as the history itself doesn't change.
- **The audit log is unaffected.** It still records counts and token names per request. Token names are only comparable across requests when the conversation vault is used.
- **Unmasked request fields leak silently.** A customer email in `metadata.user_id` reaches the provider and the audit row shows nothing. This is the same trust boundary as `allow`, except that no one opted in. Until the optional check exists, code review is the only control.
