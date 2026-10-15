# ADR 0005: Redis-backed vault for split mask/unmask processes

- Status: Accepted (implemented 2026-10-14; revised twice the same day after adversarial reviews, see Revisions)
- Date: 2026-10-14

## Context

`src/vault.ts` documented an `AsyncVault` contract for deployments where masking and unmasking happen in different processes, but nothing implemented it. Two deployments need one:

- **A gateway in front of a queue.** Process A masks the request and enqueues only placeholders. A worker calls the model. Process B picks up the reply and has to restore it, so it needs A's token → value map.
- **A conversation vault behind a load balancer** (ADR 0003, option b). Each turn can land on a different instance, and the vault has to survive that.

The store holds raw PII for minutes, so the design is mostly about what it leaks if Redis is dumped, mis-shared, or kept too long. Five questions were open: how concurrent writers agree on a token, what to do with the counter numbers a lost race burns, whether to encrypt values and how to look a value up without storing it, how a synchronous `mask()` uses an async store, and how to keep core free of Node and Redis dependencies.

## Decision

### Entry point and dependencies

`src/redis-vault.ts`, published as `pii-gate/redis`. It takes no Redis dependency and types against `RedisLike`. It uses only Web Crypto (`globalThis.crypto.subtle`), so it runs on Node ≥ 20, Deno, Bun and edge runtimes, and does not import `node:crypto`. It is a separate entry anyway, because a Redis vault in a browser bundle makes no sense and the core surface should not grow by eight exports. The option and interface types (`RedisLike`, `RedisVaultOptions`, `VaultCipher`, `AsyncVault`) stay in `vault.ts` so `pii-gate/core` keeps exporting them.

### Storage layout

One hash per request or conversation, `${keyPrefix}:${requestId}` (default prefix `pii-gate:vault`), with these fields:

| Field | Value |
|---|---|
| `g` | generation id: 128 random bits, written once (HSETNX) when the hash is created |
| `t:<g>:{{PERSON_1}}` | the value, encrypted by `cipher` |
| `v:PERSON:<hex HMAC-SHA256(indexKey, input)>` | the token |
| `n:PERSON` | allocation counter |

The HMAC input is `"<hash key>\0<g>\0<category>\0<identity>"`. `identity` is `normalizeValue(value)`, or the exact value for `LITERAL`, the same key `InMemoryVault` uses (ADR 0002). **Refinement of the contract:** the old text said `v:<category>:<normalized value>`, which would put every value in clear in a field name, where `HKEYS`, `MONITOR`, slow logs and keyspace tooling all show it. A plain hash is no better: SSNs and dates of birth are low-entropy and brute-force in seconds (ADR 0003, option c). The field is keyed with a secret `indexKey`, and the hash key is part of the input. Without it, the same SSN would produce the same `v:SSN:<mac>` in every request's hash, and anyone with read access could link one person across requests without knowing the key.

**Everything that names a value is bound to the generation:** the `t:` field name, the lookup MAC, and the cipher context (below). A hash that expires and is recreated gets a new `g`, so nothing written under the old generation can be found, decrypted or collided with under the new one. A writer therefore has to know the generation before it can look anything up, which removes a whole class of stale-read races (Revision 2).

**`requestId` is visible.** It is the clear-text part of the key name, so it shows up in `SCAN`/`KEYS`, slow logs, `MONITOR` and monitoring dashboards. Use a random or opaque id, never a user id, an email address, or a policy or claim number.

### Allocation and races

`set(value, category)`:

1. `HGET g`. If there is no generation, there is no live hash: go to step 2. Otherwise compute the lookup field for that generation and `HGET` it. If it exists, `EXPIRE` (if the key is gone, throw `VaultExpiredError`), then read `t:<g>:<token>`. If the value is there, read `g` again and return the token. Generation ids are never reused, so the same id before and after the reads means one hash the whole time. If the value is missing, the winner is still writing it or crashed (see below): `HSETNX` it with this value, then seal (step 5).
2. Otherwise `HINCRBY n:<category> 1` → `n`, `HSETNX g` with a fresh random id, then `EXPIRE`. The `HSETNX g` is a no-op unless this call created the hash. A loser adopts the existing `g`, even when its own first read in step 1 found none, so concurrent writers on a new key share one generation and never `DEL` each other.
3. `HSETNX` the lookup field (computed for the adopted generation) → `{{CATEGORY_n}}`. The first writer wins. A loser `HGET`s the winner's token.
4. `HSETNX t:<g>:<winner>` with the encrypted value. If the winner's own write finds the field already filled, a concurrent writer of the same value repaired it (step 1): the winner reads it back, decrypts it, and accepts it if it has the same identity. Only a different value, meaning corruption, makes it `DEL` the key and throw `VaultIntegrityError`.
5. **Seal:** `EXPIRE` again, then `HGET g`. If the generation changed or is gone, the key expired mid-call, and this call's writes may have recreated it or landed in a successor. Throw `VaultExpiredError` **without deleting anything**. This call's fields are named and keyed for its own (dead) generation, so in a successor hash or an orphan they are inert. Snapshots report them as `stale`, and they expire with the hash, which the `EXPIRE` just re-armed. Deleting here would destroy a live successor, or reset the counter of a writer that is creating one. The only `DEL` on the `set` path is step 4's corruption case.

Concurrent `set`s of one value always return one token, and only one `t:` field is written. The loser's `n` is **burned**, leaving a gap: `{{PERSON_1}}`, `{{PERSON_3}}`.

**Gaps are tolerated, not avoided.** Avoiding them needs either a lock or a Lua script (`EVAL`), and either one widens `RedisLike` and makes it harder to adapt. Gaps only matter to `hydrate`, which used to require dense numbering. `hydrate(entries, { allowGaps: true, counters })` now places every entry at its exact number and starts new allocations after `max(counter, highest token)`, so a burned number is never reissued. Without options, `hydrate` keeps the old dense check and error.

**Crash safety.** The lookup field is claimed before the value is written. If a writer dies between steps 3 and 4, the lookup field points at a token with no value. The snapshot reports it as `pending` and leaves it out. The next `set` of the same value fills it in through step 1, so the value is never stranded on an unrestorable token. The order is deliberate. Writing the value first would leave values that no lookup field points to. Between concurrent writers whose spellings differ only in case or whitespace, the first one to write the value sets the restored spelling. Within one writer, the first-seen spelling is kept, as in `InMemoryVault`.

### TTL

`ttlSeconds` defaults to 300. Reads (`get`, `entries`, `snapshot`, and so `loadVault`) also refresh it by default (`refreshTtlOnRead: true`), so the TTL works as an idle timeout. That is what ADR 0003 asks of a conversation vault, and it keeps a slow worker from losing the vault halfway through a tool loop. `refreshTtlOnRead: false` gives a hard deadline from the last write. `clear()` runs `DEL`. Call it when the request or conversation ends instead of waiting for the TTL.

**The TTL guarantee, stated exactly:** every `set` that writes runs `EXPIRE` before writing a value and runs `EXPIRE` again after its last write. A Redis write can't carry its own TTL, and an expired key is recreated without one. That leaves one residual window: if the key expires mid-call (which needs a stall longer than the TTL) and the process then dies or loses its connection between the write that recreated the key and the `EXPIRE` that follows it, a value stays on a key with no TTL. That orphan has no `g`, and its fields are named and keyed for the generation that expired. A snapshot reports them as `stale` and never returns them. The next `set` of any value adopts the hash: it writes a new `g` and an `EXPIRE`, and the orphan's fields stay unreadable and can't collide with new tokens until the TTL removes them. If nothing touches that key again, the orphan stays until someone deletes it. A crash right after the first `HINCRBY` of a new hash can also leave a key with no TTL, but it holds only a counter and no PII. A Lua script would close both windows; see Consequences.

### Encryption at rest

`cipher` is **required** and has no default. It is either a `VaultCipher { encrypt(plain, context), decrypt(cipher, context) }`, sync or async, or the literal string `"plaintext"`. Making plaintext a value the caller has to type means storing PII unencrypted is visible at the call site and greppable in review. A boolean like `allowPlaintext` that defaults to off, sitting beside an optional cipher, is easy to forget in one environment and hard to spot. `context` is `"<hash key>|<g>|<token>"`. A cipher should bind it as associated data, so a ciphertext copied to another token, request or generation fails to decrypt instead of restoring the wrong person's value. Cipher errors are not attached to the errors the vault throws (no `cause`), because a cipher's message may quote its input.

`createAesGcmCipher(key32)` ships as the reference: AES-256-GCM through Web Crypto, a random 96-bit IV per value, the context as AAD, output `v1.<base64(iv‖ct)>`. For per-tenant envelope encryption, unwrap the tenant's data key with your KMS and pass it in, or implement `VaultCipher` against the KMS directly.

`indexKey` is also **required**, even with `"plaintext"`, so the field layout is the same in every mode and a dev setup can't quietly reach production with clear-text field names. It is a `Uint8Array` of at least 16 bytes (HMAC-SHA256 through Web Crypto) or a function `(message) => string | Promise<string>` for a KMS or `node:crypto`. Every process sharing a vault needs the same `indexKey` and cipher key. Use a different key from the cipher's.

### Bridging to the synchronous pipeline

`mask`, `maskAll`, `unmask` and `wrapAnthropic` stay synchronous over `Vault`. Three helpers bridge them:

- `loadVault(asyncVault, { generation? })` takes one `HGETALL` snapshot, decrypts it, checks that each `t:` token's lookup field points back to it (otherwise `VaultIntegrityError`, since a wrong `indexKey` or a hand-edited hash would restore the wrong value), and hydrates an `InMemoryVault` that tolerates gaps. It remembers which tokens came from the store and the hash's generation (`generationOf(local)`). If a `generation` is passed and the hash has a different one, or none, it throws `VaultExpiredError`.
- `persistVault(local, asyncVault)` first re-reads the generation. It does this even when nothing is new, because tokens loaded from an expired hash may name other values in its successor. On a mismatch it throws `VaultExpiredError`. It then writes the entries the local vault allocated since the load, in token order, through `setInGeneration`, which checks the generation inside every `set`. If the store returns a different token for any of them, it throws `VaultConflictError` (category counts only). The text masked locally now says `{{PERSON_1}}` where the store says that value is `{{PERSON_2}}`, so it must not be sent.
- `withVault(asyncVault, fn, { maxAttempts = 3 })` runs load → `fn(vault)` → persist, retries on either error, and returns `{ result, generation }`. `maxAttempts` must be a positive integer. `fn` can run more than once, so it should only mask. The model call happens after `withVault` resolves, which also guarantees that process B can read every token the model will see.

Gateway pattern:

```ts
// Process A (gateway)
const remote = createRedisVault({ client, requestId, cipher: createAesGcmCipher(dek), indexKey });
const { result: masked, generation } = await withVault(remote, (vault) => maskAll(texts, { vault }).masked);
await queue.send({ requestId, generation, masked });

// Process B (worker / response handler)
const vault = await loadVault(createRedisVault({ client, requestId, cipher: createAesGcmCipher(dek), indexKey }), { generation });
const { text } = unmask(modelReply, vault);
```

Passing `generation` to B is part of the pattern, not an extra. Without it, B can't tell A's hash from one created after A's expired (for example, by another turn that reuses a conversation id), and it would restore A's tokens with that hash's values. With it, B gets `VaultExpiredError`. `generationOf(local)` gives the same id for vaults loaded and persisted by hand.

`withVault` returns `generation: undefined` when A stored nothing. B must still pass it. **The presence of the `generation` key turns the check on, not its value.** `{ generation: undefined }` or `{ generation: null }` means "A expected no hash": no hash gives an empty vault, and an existing hash throws `VaultExpiredError`. That way a placeholder-shaped string in the reply is never restored from a hash some other writer created under the same id. Omitting the key is the only way to skip the check.

With `wrapAnthropic`, load first, pass `createVault: () => local`, then `persistVault(local, remote)` after the call. Here the model call happens before the persist. A conflict at that point means another instance took a turn in the same conversation at the same time. This turn's reply was already restored correctly from the local vault, and the next turn reloads and re-masks the history. Serialise turns per conversation, which chat applications usually do anyway.

### Client compatibility

`RedisLike` gained `del(key): Promise<number>` for `clear()`. Without it, the only way to drop the hash early would be `EXPIRE 0`, which is easy to miss in an adapter.

- **node-redis v4** fits structurally: `hGet → string | undefined`, `hSetNX → boolean`, `hIncrBy → number`, `hGetAll → Record<string, string>`, `expire → boolean`, `del → number`. Pass the client as it is. **node-redis v5** has the same methods, but its typed RESP replies may need a cast or a thin wrapper at the type level. Runtime values match (`hSetNX`/`expire` return numbers, `hGet` returns null).
- **ioredis** uses lowercase names and returns `string | null` and numbers:

```ts
const client: RedisLike = {
  hGet: (k, f) => redis.hget(k, f),
  hSetNX: (k, f, v) => redis.hsetnx(k, f, v),
  hIncrBy: (k, f, by) => redis.hincrby(k, f, by),
  hGetAll: (k) => redis.hgetall(k),
  expire: (k, s) => redis.expire(k, s),
  del: (k) => redis.del(k),
};
```

Neither package is a dependency, so the tests check these shapes against structural stand-ins (`test/redis-vault.test.ts`), not the real type definitions. Redis Cluster works because each vault is a single key.

## Consequences

- **A Redis dump exposes no values or lookups** when a cipher is configured: `t:` holds ciphertext, and `v:` holds category names and HMACs that can't be linked across requests. Token names, category counts, the generation id and the request id in the key are still visible. That is the same set the audit log already treats as non-sensitive, as long as the request id is opaque.
- **Setup takes two secrets** (a cipher key and an index key), even for local development. That cost is deliberate.
- **Several round trips per value.** A new value in an existing hash takes nine (`HGET g`, `HGET` lookup, `HINCRBY`, `HSETNX g`, `EXPIRE`, `HSETNX` lookup, `HSETNX` value, `EXPIRE`, `HGET g`). That is one fewer for a new hash, one more for a race loser, and one more for a winner whose value was repaired. A value that already exists takes four reads plus one `EXPIRE` (`HGET g`, `HGET` lookup, `EXPIRE`, `HGET` value, `HGET g`). Add HMAC and encryption on top. `persistVault` writes new entries one at a time. For a claims note with about ten values, that is a few milliseconds on a local Redis. A Lua script that does it in one call is possible later without changing the layout.
- **Numbering can have gaps.** Token numbers are identifiers, not counts. `hydrate` without `allowGaps` still rejects gaps, so a store that never races (an `InMemoryVault` snapshot) keeps its stricter check.
- **Concurrent maskers of one key can conflict.** This is detected, never silent, and `withVault` retries it. Concurrent `set` calls for the same value always converge on one token. Concurrent `persistVault` calls can still conflict even when both processes masked the same values, because the local numbering of a second value can differ from the store's after a number was burned. Neither case deletes the vault.
- **Errors are value-free.** `VaultConflictError` carries category counts. `VaultIntegrityError` names a token at most. Constructor `TypeError`s name options and methods. `toJSON()` and `util.inspect` show only `{ store: "redis", ttlSeconds }`. The client, keys, cipher and request id are private fields.
- **TTL lapse mid-flow fails closed.** A key that expires between load and persist, or during a `set`, raises `VaultExpiredError` and never restores a token from a different hash. The cost is that a long model call can force a re-mask, so size `ttlSeconds` above the slowest round trip.
- **Not done:** key rotation (re-encrypting a live hash). With a five-minute TTL, rotating means switching keys for new requests and letting the old hashes expire.

## Revisions

### Revision 1 (adversarial review, 2026-10-14)

- **Wrong-person binding after a TTL lapse.** Reproduced: A loads `{{PERSON_1}}` = Ana and masks, the key expires during the model call, another writer creates a new hash where `{{PERSON_1}}` = Carol, A persists a new `{{PERSON_2}}` successfully, and B restores A's reply as Carol. The fix is the `g` generation field, the generation checks in `persistVault`, `setInGeneration` and the seal, `loadVault({ generation })` with `generationOf`, and the exported `VaultExpiredError`.
- **A value on a key with no TTL** if the key expired between `EXPIRE` and the lookup write. Fixed by the seal (`EXPIRE` after the last write, plus the generation check; the `DEL` it originally did was removed in Revision 3). The remaining crash window is described under TTL.
- **Linking across requests** through identical lookup HMACs. Fixed by putting the hash key into the MAC input.
- **`requestId` in key names** is now documented here, on the option, and in the README.

### Revision 2 (independent review, 2026-10-14)

- **A live vault deleted by legitimate concurrency (high).**
  - (a) A writer that read no `g` and then found A's lookup field took A's new hash for an orphan and deleted it. Through `withVault` and the README pattern, B's retry then renumbered, and A's reply was restored as B's person.
  - (b) The allocation winner deleted the vault when a concurrent writer of the same value had already repaired its value field.
  - Fixed by binding lookups and value fields to the generation (a writer never looks up without one, and a loser adopts the existing `g`) and by comparing the repaired value's identity before failing. There are deterministic interleaving tests for both.
- **The generation was not exposed by `withVault`.** It now returns `{ result, generation }`, and the README and the pattern above pass it to `loadVault`.
- **Orphan adoption (low).** A `set` of another value gave an orphan hash a `g`. The orphan's value then loaded as if it were live, and a later counter collision deleted the vault. Fixed by putting the generation into the `t:` field name, the MAC input and the cipher AAD: orphan fields are inert and reported as `stale`. This also blocks replaying a ciphertext from one generation into another.
- **Nits.**
  - `withVault` validates `maxAttempts`, which used to retry without limit on `NaN`.
  - A `cipher.encrypt` failure is wrapped in a value-free `VaultIntegrityError`.
  - Neither cipher error is attached as `cause`.

### Revision 3 (round-10 review, 2026-10-14)

- **The seal's `DEL` destroyed a live successor.** A writer that stalled past the TTL wrote its old-generation fields into a new writer's hash, and its seal then deleted that hash, which was correct and already persisted. The seal now throws `VaultExpiredError` without deleting anything, whether `g` changed or is missing. The stray fields are inert and expire with the hash.
- **`loadVault(remote, { generation: undefined })` skipped the check.** It now expects no hash: an empty vault, or `VaultExpiredError` if a hash exists. Only omitting the key skips the check.
- **Docs.** The `indexKey` JSDoc and the `createAesGcmCipher` JSDoc now describe the generation-bound MAC input and cipher context.
