/**
 * Redis-backed vault (`pii-gate/redis`, ADR 0005) for deployments where mask
 * and unmask run in different processes. No Redis dependency: it types
 * against `RedisLike`. Uses only Web Crypto (`globalThis.crypto.subtle`), so
 * it runs on Node >= 20, Deno, Bun and edge runtimes.
 */
import { LITERAL_CATEGORY, addCount, nullRecord, type Category } from "./types.js";
import {
  formatToken,
  hydrate,
  normalizeValue,
  type AsyncVault,
  type InMemoryVault,
  type RedisLike,
  type RedisVaultOptions,
  type Vault,
  type VaultCipher,
  type VaultEntry,
  type VaultIndexHmac,
} from "./vault.js";

export type { AsyncVault, RedisLike, RedisVaultOptions, VaultCipher, VaultIndexHmac } from "./vault.js";

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_PREFIX = "pii-gate:vault";
const MIN_INDEX_KEY_BYTES = 16;
const CATEGORY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const TOKEN_PATTERN = /^\{\{([A-Z][A-Z0-9_]*)_([1-9]\d*)\}\}$/;
const CLIENT_METHODS = ["hGet", "hSetNX", "hIncrBy", "hGetAll", "expire", "del"] as const;
/** Random id written once when the hash is created; a recreated hash gets a new one. */
const GENERATION_FIELD = "g";

/**
 * `persistVault` found that the store gave a value a different token than the
 * local vault used, because another process wrote to the same key in between.
 * Text masked with the local vault must not be sent; reload and mask again
 * (`withVault` does this). Carries categories and counts only.
 */
export class VaultConflictError extends Error {
  override readonly name = "VaultConflictError";
  readonly counts: Readonly<Record<string, number>>;

  constructor(counts: Record<string, number>) {
    super(
      `Vault conflict: another writer allocated tokens for ${Object.keys(counts).sort().join(", ")} concurrently; reload the vault and mask again.`,
    );
    this.counts = Object.freeze({ ...counts });
  }
}

/**
 * The vault key expired (or was deleted) and was recreated while it was in
 * use, so its token numbers may now name different values. Detected through
 * the hash's generation id. Reload the vault and mask again (`withVault` does
 * this). Carries no values.
 */
export class VaultExpiredError extends Error {
  override readonly name = "VaultExpiredError";

  constructor() {
    super(
      "Vault expired or was recreated while in use (its generation id changed), so its token numbers may name different values now; reload the vault and mask again.",
    );
  }
}

/** The stored hash is inconsistent, was tampered with, or could not be decrypted. Names tokens, never values. */
export class VaultIntegrityError extends Error {
  override readonly name = "VaultIntegrityError";
}

/** One consistent read of the hash (a single HGETALL). */
export interface VaultSnapshot {
  entries: VaultEntry[];
  /** `n:<category>` allocation counters; can exceed the highest token after a lost race. */
  counters: Record<string, number>;
  /** Lookup fields with no value in the current generation (a writer mid-`set`, one that crashed, or an orphan's). */
  pending: number;
  /** Value fields from another generation (left by a writer that crashed while recreating an expired key); ignored. */
  stale: number;
  /** The hash's generation id; undefined when the hash does not exist. */
  generation: string | undefined;
}

/**
 * An `AsyncVault` with consistent snapshots and generation ids, so
 * `loadVault`/`persistVault` can detect a key that expired and was recreated
 * between load and persist (ADR 0005).
 */
export interface SnapshotVault extends AsyncVault {
  snapshot(): Promise<VaultSnapshot>;
  /** The hash's current generation id, or undefined if it does not exist. */
  generation(): Promise<string | undefined>;
  /**
   * `set` bound to a generation: throws `VaultExpiredError` if the hash is not,
   * or stops being, `generation` during the call. With `undefined` it binds to
   * whatever generation it finds or creates, and returns it.
   */
  setInGeneration(value: string, category: Category, generation: string | undefined): Promise<{ token: string; generation: string }>;
}

export class RedisVault implements SnapshotVault {
  readonly #client: RedisLike;
  readonly #key: string;
  readonly #ttl: number;
  readonly #refreshOnRead: boolean;
  readonly #cipher: VaultCipher | undefined;
  readonly #hmac: VaultIndexHmac;

  constructor(options: RedisVaultOptions) {
    const { client, requestId, cipher, indexKey } = options;
    for (const method of CLIENT_METHODS) {
      if (typeof (client as unknown as Record<string, unknown> | undefined)?.[method] !== "function") {
        throw new TypeError(`RedisVault: client.${method} is not a function; see ADR 0005 for client adapters.`);
      }
    }
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw new TypeError("RedisVault: requestId must be a non-empty string.");
    }
    if (cipher === "plaintext") {
      this.#cipher = undefined;
    } else if (typeof cipher?.encrypt === "function" && typeof cipher.decrypt === "function") {
      this.#cipher = cipher;
    } else {
      throw new TypeError('RedisVault: cipher is required: pass a VaultCipher, or "plaintext" to store values unencrypted.');
    }
    this.#hmac = indexHmac(indexKey);
    const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isSafeInteger(ttl) || ttl < 1) {
      throw new TypeError("RedisVault: ttlSeconds must be a positive integer.");
    }
    this.#client = client;
    this.#ttl = ttl;
    this.#refreshOnRead = options.refreshTtlOnRead ?? true;
    this.#key = `${options.keyPrefix ?? DEFAULT_PREFIX}:${requestId}`;
  }

  /** The Redis hash key, `${keyPrefix}:${requestId}`. */
  get key(): string {
    return this.#key;
  }

  async get(token: string): Promise<string | undefined> {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const generation = await this.generation();
    if (generation === undefined) return undefined;
    const stored = await this.#client.hGet(this.#key, valueField(generation, token));
    if (stored === null || stored === undefined) return undefined;
    await this.#touchOnRead();
    return this.#decrypt(stored, generation, token);
  }

  /** Existing token for (value, category) in the current generation, if any. */
  async tokenFor(value: string, category: Category): Promise<string | undefined> {
    assertStoreCategory(category);
    const generation = await this.generation();
    if (generation === undefined) return undefined;
    const token = await this.#client.hGet(this.#key, await this.#indexField(value, category, generation));
    return token ?? undefined;
  }

  /**
   * Returns the token for (value, category), allocating one if needed.
   * Concurrent writers of the same value converge on one token: each takes a
   * number with HINCRBY, the first HSETNX on the lookup field wins, and the
   * loser reads the winner's token (its number is burned, leaving a gap).
   */
  async set(value: string, category: Category): Promise<string> {
    return (await this.setInGeneration(value, category, undefined)).token;
  }

  async generation(): Promise<string | undefined> {
    return (await this.#client.hGet(this.#key, GENERATION_FIELD)) || undefined;
  }

  async setInGeneration(
    value: string,
    category: Category,
    expected: string | undefined,
  ): Promise<{ token: string; generation: string }> {
    assertStoreCategory(category);
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError("RedisVault: value must be a non-empty string.");
    }
    const client = this.#client;
    const key = this.#key;
    const before = await this.generation();
    if (expected !== undefined && before !== expected) throw new VaultExpiredError();

    // Lookup fields are bound to a generation, so a lookup needs one. Without a generation there is no live hash:
    // allocate, which creates or adopts it.
    if (before !== undefined) {
      const existing = await client.hGet(key, await this.#indexField(value, category, before));
      if (existing) {
        assertTokenFor(existing, category);
        if (!truthy(await client.expire(key, this.#ttl))) throw new VaultExpiredError();
        const field = valueField(before, existing);
        const stored = await client.hGet(key, field);
        if (stored === null || stored === undefined) {
          // The winner is mid-write or crashed: write the value ourselves (the winner accepts it, see below).
          await client.hSetNX(key, field, await this.#encrypt(value, before, existing));
          await this.#seal(before);
        } else if ((await this.generation()) !== before) {
          // Generation ids are never reused, so equal ids around the reads mean one hash throughout.
          throw new VaultExpiredError();
        }
        return { token: existing, generation: before };
      }
    }

    const n = await client.hIncrBy(key, `n:${category}`, 1);
    const mine = newGeneration();
    const generation = truthy(await client.hSetNX(key, GENERATION_FIELD, mine)) ? mine : await this.generation();
    await client.expire(key, this.#ttl);
    if (generation === undefined || (expected !== undefined && generation !== expected)) throw new VaultExpiredError();
    const lookup = await this.#indexField(value, category, generation);
    const token = formatToken(category, n);
    const won = truthy(await client.hSetNX(key, lookup, token));
    const winner = won ? token : await client.hGet(key, lookup);
    if (!winner) {
      await this.#seal(generation);
      throw new VaultIntegrityError(`RedisVault: lost the allocation race for ${category} but no winning token is stored.`);
    }
    assertTokenFor(winner, category);
    const field = valueField(generation, winner);
    const filled = truthy(await client.hSetNX(key, field, await this.#encrypt(value, generation, winner)));
    await this.#seal(generation);
    if (won && !filled) {
      // Legitimate only if a concurrent writer of the same value repaired our token before we wrote it.
      const stored = await client.hGet(key, field);
      const theirs = stored === null || stored === undefined ? undefined : await this.#decrypt(stored, generation, winner);
      if (theirs === undefined || identity(theirs, category) !== identity(value, category)) {
        await client.del(key);
        throw new VaultIntegrityError(`RedisVault: ${winner} was allocated but holds another value; the vault was dropped.`);
      }
    }
    return { token: winner, generation };
  }

  async entries(): Promise<VaultEntry[]> {
    return (await this.snapshot()).entries;
  }

  async snapshot(): Promise<VaultSnapshot> {
    const all = await this.#client.hGetAll(this.#key);
    const fields = Object.keys(all);
    const generation = all[GENERATION_FIELD] || undefined;
    const counters = nullRecord<number>();
    const lookups: string[] = [];
    const stored: [string, string][] = [];
    let stale = 0;
    for (const field of fields) {
      const raw = all[field] ?? "";
      if (field.startsWith("n:")) {
        const n = Number(raw);
        if (Number.isSafeInteger(n) && n > 0) counters[field.slice(2)] = n;
      } else if (field.startsWith("v:")) {
        lookups.push(raw);
      } else if (field.startsWith("t:")) {
        // Values from another generation (an orphan left by a writer that crashed mid-recreation) are inert.
        if (generation !== undefined && field.startsWith(`t:${generation}:`)) {
          stored.push([field.slice(3 + generation.length), raw]);
        } else {
          stale++;
        }
      }
    }
    const entries =
      generation === undefined
        ? []
        : await Promise.all(
            stored.map(async ([token, raw]): Promise<VaultEntry> => {
              const category = tokenCategory(token);
              const value = await this.#decrypt(raw, generation, token);
              // The lookup field must point back at this token, otherwise the hash was edited by hand or tampered with.
              if (all[await this.#indexField(value, category, generation)] !== token) {
                throw new VaultIntegrityError(`RedisVault: ${token} does not match its lookup field; refusing to load the vault.`);
              }
              return { token, value, category };
            }),
          );
    const written = new Set(entries.map((e) => e.token));
    if (fields.length > 0) await this.#touchOnRead();
    return { entries, counters, pending: lookups.filter((t) => !written.has(t)).length, stale, generation };
  }

  /** Deletes the whole hash. Call when the request or conversation ends. */
  async clear(): Promise<void> {
    await this.#client.del(this.#key);
  }

  /** Never exposes values, keys or the client when logged or serialised. */
  toJSON(): { store: "redis"; ttlSeconds: number } {
    return { store: "redis", ttlSeconds: this.#ttl };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `RedisVault { ttlSeconds: ${this.#ttl} }`;
  }

  /**
   * After the last write of a `set`: re-arm the TTL (a write that landed after
   * the key expired recreated it without one), then confirm the hash is still
   * the generation we wrote into. If not, throw without deleting anything: our
   * fields are named and keyed for the old generation, so they are inert in a
   * successor or orphan (reported as `stale`) and expire with it. A DEL here
   * would destroy a live successor, or the counter of a writer creating one.
   */
  async #seal(generation: string): Promise<void> {
    await this.#client.expire(this.#key, this.#ttl);
    if ((await this.generation()) !== generation) throw new VaultExpiredError();
  }

  async #indexField(value: string, category: Category, generation: string): Promise<string> {
    // The hash key and generation are part of the MAC input: one value gets unrelated lookup fields in different
    // requests (no cross-request linking) and in a recreated hash (an orphan's fields are inert).
    const mac = await this.#hmac(`${this.#key}\u0000${generation}\u0000${category}\u0000${identity(value, category)}`);
    if (typeof mac !== "string" || mac.length === 0) {
      throw new TypeError("RedisVault: indexKey function must return a non-empty string.");
    }
    return `v:${category}:${mac}`;
  }

  async #encrypt(value: string, generation: string, token: string): Promise<string> {
    if (!this.#cipher) return value;
    let out: unknown;
    try {
      out = await this.#cipher.encrypt(value, cipherContext(this.#key, generation, token));
    } catch {
      // The cipher's own error is not attached: it may quote its input.
      throw new VaultIntegrityError(`RedisVault: cipher.encrypt failed for ${token}.`);
    }
    if (typeof out !== "string") throw new TypeError("RedisVault: cipher.encrypt must return a string.");
    return out;
  }

  async #decrypt(stored: string, generation: string, token: string): Promise<string> {
    if (!this.#cipher) return stored;
    let out: unknown;
    try {
      out = await this.#cipher.decrypt(stored, cipherContext(this.#key, generation, token));
    } catch {
      // The cipher's own error is not attached: it may quote its input.
      throw new VaultIntegrityError(`RedisVault: could not decrypt the value for ${token}.`);
    }
    if (typeof out !== "string") throw new VaultIntegrityError(`RedisVault: cipher.decrypt returned a non-string for ${token}.`);
    return out;
  }

  async #touchOnRead(): Promise<void> {
    if (this.#refreshOnRead) await this.#client.expire(this.#key, this.#ttl);
  }
}

export function createRedisVault(options: RedisVaultOptions): RedisVault {
  return new RedisVault(options);
}

// ---------------------------------------------------------------------------
// Bridging to the synchronous pipeline (mask, maskAll, unmask, wrapAnthropic).

interface PersistState {
  /** Tokens this local vault already shares with the store. */
  tokens: Set<string>;
  /** Store generation the local numbering belongs to; undefined until the hash exists. */
  generation: string | undefined;
}

const persisted = new WeakMap<Vault, PersistState>();

export interface LoadVaultOptions {
  /**
   * Generation the caller expects (`withVault(...).generation` or
   * `generationOf` in the process that masked). A different or missing
   * generation throws `VaultExpiredError` instead of restoring tokens with
   * another hash's values. Passing the key with `undefined` or `null` (A stored
   * nothing) expects no hash: an existing one throws `VaultExpiredError`, no
   * hash gives an empty vault. Omit the key only to skip the check.
   */
  generation?: string | null | undefined;
}

/**
 * Reads the store into an `InMemoryVault` for the synchronous functions.
 * Token numbers are kept exactly (gaps from lost races included) and new
 * local tokens continue after the store's counters.
 */
export async function loadVault(source: AsyncVault, options: LoadVaultOptions = {}): Promise<InMemoryVault> {
  const snap = isSnapshotVault(source)
    ? await source.snapshot()
    : { entries: await source.entries(), counters: {}, generation: undefined };
  // Presence of the key, not its value, turns the check on: `{ generation: undefined }` means "expect no hash".
  if (Object.hasOwn(options, "generation") && snap.generation !== (options.generation ?? undefined)) {
    throw new VaultExpiredError();
  }
  const vault = hydrate(snap.entries, { allowGaps: true, counters: snap.counters });
  persisted.set(vault, { tokens: new Set(snap.entries.map((e) => e.token)), generation: snap.generation });
  return vault;
}

/**
 * The store generation a loaded (and possibly persisted) local vault belongs
 * to. Send it along with the masked text so the unmasking process can pass it
 * to `loadVault({ generation })`.
 */
export function generationOf(local: Vault): string | undefined {
  return persisted.get(local)?.generation;
}

export interface PersistResult {
  /** Entries newly written to the store. */
  written: number;
}

/**
 * Writes entries the local vault allocated since `loadVault` (or all entries,
 * for a vault that was not loaded) to the store, in token order. Throws
 * `VaultConflictError` if the store assigns any of them a different token,
 * meaning another process wrote concurrently: the locally masked text is then
 * wrong and must be masked again from a fresh load.
 */
export async function persistVault(local: Vault, remote: AsyncVault): Promise<PersistResult> {
  const state = persisted.get(local) ?? { tokens: new Set<string>(), generation: undefined };
  persisted.set(local, state);
  const fresh = local
    .entries()
    .filter((e) => !state.tokens.has(e.token))
    .sort((a, b) => tokenNumber(a.token) - tokenNumber(b.token));
  const generational = isSnapshotVault(remote);
  // Checked even when nothing is new: tokens loaded from an expired hash may name other values in its successor.
  if (generational && state.generation !== undefined && (await remote.generation()) !== state.generation) {
    throw new VaultExpiredError();
  }
  let written = 0;
  for (const entry of fresh) {
    let token: string;
    if (generational) {
      const r = await remote.setInGeneration(entry.value, entry.category, state.generation);
      token = r.token;
      state.generation = r.generation;
    } else {
      token = await remote.set(entry.value, entry.category);
    }
    if (token !== entry.token) {
      const counts = nullRecord<number>();
      addCount(counts, entry.category);
      throw new VaultConflictError(counts);
    }
    state.tokens.add(token);
    written++;
  }
  return { written };
}

export interface WithVaultOptions {
  /** Default 3; a positive integer. Each attempt reloads the vault and runs `fn` again. */
  maxAttempts?: number;
}

export interface WithVaultResult<T> {
  result: T;
  /**
   * Store generation the masked output belongs to. Send it with the masked
   * text and pass it to `loadVault(remote, { generation })` in the process
   * that unmasks. Undefined only if nothing was ever stored.
   */
  generation: string | undefined;
}

/**
 * load → `fn(vault)` → persist, retrying on `VaultConflictError` and
 * `VaultExpiredError`. `fn` may run more than once, so it must not have side
 * effects: mask inside it, and send the masked text to the model only after
 * `withVault` resolves.
 */
export async function withVault<T>(
  remote: AsyncVault,
  fn: (vault: InMemoryVault) => T | Promise<T>,
  options: WithVaultOptions = {},
): Promise<WithVaultResult<T>> {
  const attempts = options.maxAttempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new TypeError("withVault: maxAttempts must be a positive integer.");
  }
  for (let attempt = 1; ; attempt++) {
    const vault = await loadVault(remote);
    const result = await fn(vault);
    try {
      await persistVault(vault, remote);
      return { result, generation: generationOf(vault) };
    } catch (error) {
      const retryable = error instanceof VaultConflictError || error instanceof VaultExpiredError;
      if (!retryable || attempt >= attempts) throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Web Crypto helpers.

/**
 * AES-256-GCM `VaultCipher` with a random 96-bit IV per value and the
 * `<hash key>|<generation>|<token>` context as associated data. Output: `v1.` + base64(iv || ciphertext).
 * For envelope encryption, unwrap the tenant's data key with your KMS and pass it here.
 */
export function createAesGcmCipher(key: Uint8Array): VaultCipher {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new TypeError("createAesGcmCipher: key must be a 32-byte Uint8Array.");
  }
  const cryptoKey = subtle().importKey("raw", new Uint8Array(key), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const encoder = new TextEncoder();
  return {
    async encrypt(plaintext, context) {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle().encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
        await cryptoKey,
        encoder.encode(plaintext),
      );
      const out = new Uint8Array(12 + ct.byteLength);
      out.set(iv);
      out.set(new Uint8Array(ct), 12);
      return `v1.${toBase64(out)}`;
    },
    async decrypt(ciphertext, context) {
      if (!ciphertext.startsWith("v1.")) throw new Error("Unknown ciphertext format.");
      const bytes = fromBase64(ciphertext.slice(3));
      const pt = await subtle().decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: encoder.encode(context) },
        await cryptoKey,
        bytes.slice(12),
      );
      return new TextDecoder().decode(pt);
    },
  };
}

function indexHmac(indexKey: RedisVaultOptions["indexKey"]): VaultIndexHmac {
  if (typeof indexKey === "function") return indexKey;
  if (!(indexKey instanceof Uint8Array) || indexKey.byteLength < MIN_INDEX_KEY_BYTES) {
    throw new TypeError(
      `RedisVault: indexKey is required: a Uint8Array of at least ${MIN_INDEX_KEY_BYTES} bytes, or an HMAC function.`,
    );
  }
  const keyPromise = subtle().importKey("raw", new Uint8Array(indexKey), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const encoder = new TextEncoder();
  return async (message) => toHex(new Uint8Array(await subtle().sign("HMAC", await keyPromise, encoder.encode(message))));
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("pii-gate/redis needs Web Crypto (globalThis.crypto.subtle); Node >= 20 provides it.");
  return s;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------

function isSnapshotVault(vault: AsyncVault): vault is SnapshotVault {
  const v = vault as Partial<SnapshotVault>;
  return typeof v.snapshot === "function" && typeof v.generation === "function" && typeof v.setInGeneration === "function";
}

/** `t:<generation>:<token>`: values are scoped to the hash generation that issued their token. */
function valueField(generation: string, token: string): string {
  return `t:${generation}:${token}`;
}

/** Associated data for the cipher: binds a ciphertext to its hash, generation and token. */
function cipherContext(key: string, generation: string, token: string): string {
  return `${key}|${generation}|${token}`;
}

/** Same identity as InMemoryVault: folded for PII, exact for escaped literals (ADR 0002). */
function identity(value: string, category: Category): string {
  return category === LITERAL_CATEGORY ? value : normalizeValue(value);
}

function newGeneration(): string {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

function assertTokenFor(token: string, category: Category): void {
  if (!TOKEN_PATTERN.test(token) || tokenCategory(token) !== category) {
    throw new VaultIntegrityError(`RedisVault: a ${category} lookup field holds a malformed token; refusing to use it.`);
  }
}

function assertStoreCategory(category: string): void {
  if (typeof category !== "string" || !CATEGORY_PATTERN.test(category)) {
    throw new TypeError("RedisVault: category must be UPPER_SNAKE_CASE.");
  }
}

function tokenCategory(token: string): Category {
  const m = TOKEN_PATTERN.exec(token);
  if (!m?.[1]) throw new VaultIntegrityError("RedisVault: the stored hash holds a malformed token field.");
  return m[1];
}

function tokenNumber(token: string): number {
  return Number(/_(\d+)\}\}$/.exec(token)?.[1] ?? Number.NaN);
}

function truthy(reply: boolean | number): boolean {
  return reply === true || (typeof reply === "number" && reply > 0);
}
