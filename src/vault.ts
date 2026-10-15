import { LITERAL_CATEGORY, type Category } from "./types.js";

export interface VaultEntry {
  token: string;
  value: string;
  category: Category;
}

/**
 * Bidirectional token <-> value store for one request.
 *
 * Scope: one round trip, one tool loop, or one conversation; never across
 * conversations or users (see ADR 0003). Do not reuse a vault across users or sessions:
 * token numbering is only meaningful inside it, and keeping originals around
 * longer than needed widens the blast radius of a memory dump or a logged
 * object. Persistent implementations should set a short TTL (minutes).
 */
export interface Vault {
  /** Original value for a placeholder token, e.g. "{{SSN_1}}". */
  get(token: string): string | undefined;
  /** Existing token for an original value within a category, if any. */
  tokenFor(value: string, category: Category): string | undefined;
  /** Returns the existing token for (value, category) or allocates `{{CATEGORY_n}}`. */
  set(value: string, category: Category): string;
  entries(): VaultEntry[];
  readonly size: number;
}

export function formatToken(category: Category, n: number): string {
  return `{{${category}_${n}}}`;
}

/**
 * Identity used for "same value" checks: whitespace runs collapse and case
 * folds, so "Robert\nChen" and "robert chen" share one token. Unmasking
 * restores the first-seen spelling, so case/line-break variants are lossy.
 */
export function normalizeValue(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Module-private hook for `hydrate`: places an entry at its exact token number. */
let restoreInto: (vault: InMemoryVault, entry: VaultEntry, n: number) => void;
/** Module-private hook for `hydrate`: raises a category counter so new tokens skip burned numbers. */
let raiseCounter: (vault: InMemoryVault, category: Category, n: number) => void;

export class InMemoryVault implements Vault {
  static {
    restoreInto = (vault, entry, n) => {
      const key = InMemoryVault.#key(entry.value, entry.category);
      if (vault.#byToken.has(entry.token) || vault.#byValue.has(key)) {
        throw new Error(`Vault snapshot is inconsistent: ${entry.token} duplicates a token or a value already restored.`);
      }
      vault.#byToken.set(entry.token, { token: entry.token, value: entry.value, category: entry.category });
      vault.#byValue.set(key, entry.token);
      raiseCounter(vault, entry.category, n);
    };
    raiseCounter = (vault, category, n) => {
      if (n > (vault.#counters.get(category) ?? 0)) vault.#counters.set(category, n);
    };
  }

  readonly #byToken = new Map<string, VaultEntry>();
  readonly #byValue = new Map<string, string>();
  readonly #counters = new Map<Category, number>();

  get size(): number {
    return this.#byToken.size;
  }

  get(token: string): string | undefined {
    return this.#byToken.get(token)?.value;
  }

  tokenFor(value: string, category: Category): string | undefined {
    return this.#byValue.get(InMemoryVault.#key(value, category));
  }

  set(value: string, category: Category): string {
    const key = InMemoryVault.#key(value, category);
    const existing = this.#byValue.get(key);
    if (existing) return existing;
    const n = (this.#counters.get(category) ?? 0) + 1;
    this.#counters.set(category, n);
    const token = formatToken(category, n);
    this.#byToken.set(token, { token, value, category });
    this.#byValue.set(key, token);
    return token;
  }

  entries(): VaultEntry[] {
    return [...this.#byToken.values()].map((e) => ({ ...e }));
  }

  /** Drops all originals. Call when the request completes if the vault object may outlive it. */
  clear(): void {
    this.#byToken.clear();
    this.#byValue.clear();
    this.#counters.clear();
  }

  /** Avoids leaking originals through console.log / JSON.stringify of the vault. */
  toJSON(): { size: number } {
    return { size: this.size };
  }

  static #key(value: string, category: Category): string {
    // Escaped literals must round-trip to their exact spelling, so "{{ssn_1}}" and "{{SSN_1}}" get separate tokens.
    return `${category}\u0000${category === LITERAL_CATEGORY ? value : normalizeValue(value)}`;
  }
}

/**
 * Minimal surface of a Redis client needed by the Redis-backed vault
 * (`createRedisVault` in `pii-gate/redis`). node-redis v4/v5 clients match it
 * as they are; ioredis needs a six-line adapter (lowercase method names, see
 * ADR 0005). No Redis dependency is taken here.
 */
export interface RedisLike {
  hGet(key: string, field: string): Promise<string | null | undefined>;
  hSetNX(key: string, field: string, value: string): Promise<boolean | number>;
  hIncrBy(key: string, field: string, by: number): Promise<number>;
  hGetAll(key: string): Promise<Record<string, string>>;
  expire(key: string, seconds: number): Promise<boolean | number>;
  /** Used by `clear()` to drop the whole hash when the request or conversation ends. */
  del(key: string): Promise<number>;
}

/**
 * Async counterpart of `Vault` for deployments where mask and unmask run in
 * different processes (e.g. a gateway in front of a queue). Implemented by
 * `createRedisVault` in `pii-gate/redis` (ADR 0005). Load a snapshot into an
 * `InMemoryVault` (`loadVault`, or `hydrate`) to reuse the synchronous
 * mask/unmask functions, and write new entries back with `persistVault`.
 */
export interface AsyncVault {
  get(token: string): Promise<string | undefined>;
  set(value: string, category: Category): Promise<string>;
  entries(): Promise<VaultEntry[]>;
}

/**
 * Encrypts vault values before they are written to the store and decrypts them
 * on read. `context` is `"<hash key>|<generation>|<token>"`: bind it as associated data
 * (AES-GCM AAD) so a ciphertext copied to another token or request fails to
 * decrypt. Envelope encryption with a per-tenant data key belongs here.
 */
export interface VaultCipher {
  encrypt(plaintext: string, context: string): Promise<string> | string;
  decrypt(ciphertext: string, context: string): Promise<string> | string;
}

/** Keyed hash for the `v:` lookup field (hex or base64 string out). Must be the same in every process. */
export type VaultIndexHmac = (message: string) => Promise<string> | string;

export interface RedisVaultOptions {
  client: RedisLike;
  /**
   * Per-request (or per-conversation, ADR 0003) namespace. Never per user across conversations.
   * It appears in clear in the Redis key name, so in SCAN/KEYS output, slow logs, MONITOR and
   * monitoring tools: use a random or opaque id, never a user id, email, policy or claim number.
   */
  requestId: string;
  /**
   * Required. A `VaultCipher` to encrypt values at rest, or the string
   * `"plaintext"` to store originals in clear (local development only). There
   * is no default, so storing PII unencrypted is a visible decision at the call
   * site.
   */
  cipher: VaultCipher | "plaintext";
  /**
   * Required. Secret for the `v:` lookup field, which is
   * `v:<category>:HMAC-SHA256(indexKey, key + "\0" + generation + "\0" + category + "\0" + identity)`
   * (hash key, the hash's generation id, and the normalized value, or the exact
   * text for `LITERAL`), so the field name never carries the value and cannot be
   * linked across requests or generations. A `Uint8Array` (at least 16
   * bytes) uses Web Crypto; a function lets you use a KMS or `node:crypto`.
   * Every process sharing a vault must use the same key. Separate from the
   * cipher key.
   */
  indexKey: Uint8Array | VaultIndexHmac;
  /** Keep this short. Default 300s: long enough for a tool loop, short enough to limit exposure. */
  ttlSeconds?: number;
  /** Default true: reads (`get`, `entries`, `snapshot`) also refresh the TTL, so it acts as an idle timeout. */
  refreshTtlOnRead?: boolean;
  /** Default `"pii-gate:vault"`. The hash key is `${keyPrefix}:${requestId}`. */
  keyPrefix?: string;
}

export type RedisVaultFactory = (options: RedisVaultOptions) => AsyncVault;

export interface HydrateOptions {
  /**
   * Allocation counters per category from the store (e.g. Redis `n:<category>`).
   * New tokens continue after `max(counter, highest token)`, so numbers burned
   * by a lost allocation race are never reissued.
   */
  counters?: Readonly<Record<string, number>>;
  /**
   * Default false: numbering must be dense (`_1.._n`), as an `InMemoryVault`
   * produces. True places each entry at its exact token number, which is what
   * a store with concurrent writers produces (ADR 0005).
   */
  allowGaps?: boolean;
}

/** Builds an InMemoryVault from persisted entries, preserving token numbering. */
export function hydrate(entries: readonly VaultEntry[], options: HydrateOptions = {}): InMemoryVault {
  const vault = new InMemoryVault();
  const sorted = [...entries].sort((a, b) => tokenNumber(a.token) - tokenNumber(b.token));
  for (const entry of sorted) {
    if (options.allowGaps === true) {
      const n = tokenNumber(entry.token);
      if (!Number.isSafeInteger(n) || n < 1 || formatToken(entry.category, n) !== entry.token) {
        throw new Error(`Vault snapshot has a malformed token for ${entry.category}; cannot hydrate faithfully.`);
      }
      restoreInto(vault, entry, n);
      continue;
    }
    const token = vault.set(entry.value, entry.category);
    if (token !== entry.token) {
      throw new Error(`Vault snapshot has gaps in numbering for ${entry.category}; cannot hydrate faithfully.`);
    }
  }
  for (const [category, n] of Object.entries(options.counters ?? {})) {
    if (Number.isSafeInteger(n) && n > 0) raiseCounter(vault, category, n);
  }
  return vault;
}

function tokenNumber(token: string): number {
  return Number(/_(\d+)\}\}$/.exec(token)?.[1] ?? Number.NaN);
}
