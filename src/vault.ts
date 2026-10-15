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

export class InMemoryVault implements Vault {
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
 * Minimal surface of a Redis client needed by a Redis-backed vault. Matches
 * node-redis v4 and ioredis closely enough to adapt in a few lines; no Redis
 * dependency is taken here.
 */
export interface RedisLike {
  hGet(key: string, field: string): Promise<string | null | undefined>;
  hSetNX(key: string, field: string, value: string): Promise<boolean | number>;
  hIncrBy(key: string, field: string, by: number): Promise<number>;
  hGetAll(key: string): Promise<Record<string, string>>;
  expire(key: string, seconds: number): Promise<boolean | number>;
}

export interface RedisVaultOptions {
  client: RedisLike;
  /** Per-request namespace, e.g. the request id. */
  requestId: string;
  /** Keep this short. Default 300s: long enough for a tool loop, short enough to limit exposure. */
  ttlSeconds?: number;
  keyPrefix?: string;
}

/**
 * Async counterpart of `Vault` for deployments where mask and unmask run in
 * different processes (e.g. a gateway in front of a queue). Not implemented
 * in this package; the contract is:
 *
 *  - one hash per request: `${prefix}:${requestId}` with fields
 *    `t:<token>` -> value, `v:<category>:<normalized value>` -> token, `n:<category>` -> counter
 *  - `set` allocates with HINCRBY + HSETNX so concurrent writers converge on one token
 *  - every write refreshes EXPIRE to `ttlSeconds`
 *  - values should be encrypted at rest (envelope key per tenant) before HSET
 *
 * Load a snapshot into an `InMemoryVault` (`hydrate`) to reuse the synchronous mask/unmask functions.
 */
export interface AsyncVault {
  get(token: string): Promise<string | undefined>;
  set(value: string, category: Category): Promise<string>;
  entries(): Promise<VaultEntry[]>;
}

export type RedisVaultFactory = (options: RedisVaultOptions) => AsyncVault;

/** Builds an InMemoryVault from persisted entries, preserving token numbering. */
export function hydrate(entries: readonly VaultEntry[]): InMemoryVault {
  const vault = new InMemoryVault();
  const sorted = [...entries].sort((a, b) => tokenNumber(a.token) - tokenNumber(b.token));
  for (const entry of sorted) {
    const token = vault.set(entry.value, entry.category);
    if (token !== entry.token) {
      throw new Error(`Vault snapshot has gaps in numbering for ${entry.category}; cannot hydrate faithfully.`);
    }
  }
  return vault;
}

function tokenNumber(token: string): number {
  return Number(/_(\d+)\}\}$/.exec(token)?.[1] ?? Number.NaN);
}
