import type { RedisLike } from "../src/redis-vault.js";

interface Entry {
  hash: Map<string, string>;
  /** Epoch ms; undefined = no TTL (persistent), like a fresh Redis key. */
  expiresAt: number | undefined;
}

export type CallHook = (method: string, key: string, field: string | undefined) => Promise<void> | void;

/**
 * In-memory Redis with the hash/TTL semantics the vault relies on:
 * - a write to a missing key creates it with no TTL; writes to an existing key keep its TTL;
 * - EXPIRE returns 1 only if the key exists; EXPIRE <= 0 deletes the key;
 * - expired keys are invisible (lazy expiry against an injectable clock);
 * - HSETNX returns 1 if it set the field, 0 if the field existed;
 * - HINCRBY treats a missing field as 0; HGET on a missing field/key returns null;
 * - an empty hash does not exist.
 */
export class FakeRedis implements RedisLike {
  readonly #data = new Map<string, Entry>();
  now = 0;
  /** Called before every command; lets a test pause or fail a command to interleave writers. */
  onCall: CallHook | undefined;
  readonly log: string[] = [];

  advance(seconds: number): void {
    this.now += seconds * 1000;
  }

  /** Redis TTL: -2 missing, -1 no expiry, else remaining whole seconds. */
  ttl(key: string): number {
    const e = this.#live(key);
    if (!e) return -2;
    if (e.expiresAt === undefined) return -1;
    return Math.ceil((e.expiresAt - this.now) / 1000);
  }

  /** Raw view of a hash, for assertions. */
  raw(key: string): Record<string, string> {
    return Object.fromEntries(this.#live(key)?.hash ?? []);
  }

  /** Direct write, for tamper tests. */
  poke(key: string, field: string, value: string): void {
    this.#create(key).hash.set(field, value);
  }

  keys(): string[] {
    return [...this.#data.keys()].filter((k) => this.#live(k));
  }

  async hGet(key: string, field: string): Promise<string | null> {
    await this.#before("hGet", key, field);
    return this.#live(key)?.hash.get(field) ?? null;
  }

  async hSetNX(key: string, field: string, value: string): Promise<number> {
    await this.#before("hSetNX", key, field);
    const e = this.#create(key);
    if (e.hash.has(field)) return 0;
    e.hash.set(field, value);
    return 1;
  }

  async hIncrBy(key: string, field: string, by: number): Promise<number> {
    await this.#before("hIncrBy", key, field);
    const e = this.#create(key);
    const current = Number(e.hash.get(field) ?? "0");
    if (!Number.isInteger(current)) throw new Error("ERR hash value is not an integer");
    const next = current + by;
    e.hash.set(field, String(next));
    return next;
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    await this.#before("hGetAll", key, undefined);
    return this.raw(key);
  }

  async expire(key: string, seconds: number): Promise<number> {
    await this.#before("expire", key, undefined);
    const e = this.#live(key);
    if (!e) return 0;
    if (seconds <= 0) {
      this.#data.delete(key);
      return 1;
    }
    e.expiresAt = this.now + seconds * 1000;
    return 1;
  }

  async del(key: string): Promise<number> {
    await this.#before("del", key, undefined);
    return this.#live(key) && this.#data.delete(key) ? 1 : 0;
  }

  async #before(method: string, key: string, field: string | undefined): Promise<void> {
    this.log.push(field === undefined ? method : `${method} ${field.slice(0, 2)}`);
    await this.onCall?.(method, key, field);
  }

  #live(key: string): Entry | undefined {
    const e = this.#data.get(key);
    if (!e) return undefined;
    if ((e.expiresAt !== undefined && e.expiresAt <= this.now) || e.hash.size === 0) {
      this.#data.delete(key);
      return undefined;
    }
    return e;
  }

  #create(key: string): Entry {
    const live = this.#live(key);
    if (live) return live;
    const e: Entry = { hash: new Map(), expiresAt: undefined };
    this.#data.set(key, e);
    return e;
  }
}
