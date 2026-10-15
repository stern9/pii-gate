import { inspect } from "node:util";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryVault, LITERAL_CATEGORY, hydrate, maskAll, unmask, wrapAnthropic } from "../src/index.js";
import {
  RedisVault,
  VaultConflictError,
  VaultExpiredError,
  VaultIntegrityError,
  createAesGcmCipher,
  createRedisVault,
  generationOf,
  loadVault,
  persistVault,
  withVault,
  type RedisLike,
  type RedisVaultOptions,
  type VaultCipher,
} from "../src/redis-vault.js";
import { FakeAnthropic, textMessage, textOf, type TestParams } from "./fake-client.js";
import { FakeRedis } from "./fake-redis.js";

// Fabricated PII only.
const NAME = "Robert Chen";
const NAME_2 = "Maria Alvarez";
const SSN = "123-45-6789";
const EMAIL = "robert.chen@example.com";
const ALL_VALUES = [NAME, NAME_2, SSN, EMAIL, NAME.toLowerCase(), NAME_2.toLowerCase()];

const INDEX_KEY = new Uint8Array(32).fill(7);
const CIPHER_KEY = new Uint8Array(32).fill(9);
const REQ = "req-42";
const KEY = `pii-gate:vault:${REQ}`;

function vaultOn(client: RedisLike, extra: Partial<RedisVaultOptions> = {}): RedisVault {
  return createRedisVault({
    client,
    requestId: REQ,
    cipher: createAesGcmCipher(CIPHER_KEY),
    indexKey: INDEX_KEY,
    ...extra,
  });
}

function expectValueFree(text: string): void {
  for (const v of ALL_VALUES) expect(text).not.toContain(v);
}

async function errorOf(p: Promise<unknown> | (() => unknown)): Promise<Error> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("non-Error thrown");
  }
  throw new Error("expected a rejection");
}

function gate(): { p: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

/** A per-process view of a shared FakeRedis with its own call hook (method, field, call index). */
function proc(redis: FakeRedis, hook: (m: string, f: string | undefined, i: number) => Promise<void> | void): RedisLike {
  let i = 0;
  const pre = async (m: string, f?: string) => hook(m, f, i++);
  return {
    hGet: async (k, f) => (await pre("hGet", f), redis.hGet(k, f)),
    hSetNX: async (k, f, v) => (await pre("hSetNX", f), redis.hSetNX(k, f, v)),
    hIncrBy: async (k, f, by) => (await pre("hIncrBy", f), redis.hIncrBy(k, f, by)),
    hGetAll: async (k) => (await pre("hGetAll"), redis.hGetAll(k)),
    expire: async (k, sec) => (await pre("expire"), redis.expire(k, sec)),
    del: async (k) => (await pre("del"), redis.del(k)),
  };
}

/** Pauses the first `n` callers of a command on matching fields until all `n` have arrived. */
function barrier(redis: FakeRedis, method: string, fieldPrefix: string, n: number): void {
  let arrived = 0;
  let release: () => void = () => undefined;
  const all = new Promise<void>((r) => (release = r));
  redis.onCall = async (m, _key, field) => {
    if (m !== method || !field?.startsWith(fieldPrefix) || arrived >= n) return;
    if (++arrived === n) release();
    await all;
  };
}

describe("RedisVault: allocation and identity", () => {
  it("allocates per-category tokens, stable per normalized value, keeping the first-seen spelling", async () => {
    const vault = vaultOn(new FakeRedis());
    expect(await vault.set(NAME, "PERSON")).toBe("{{PERSON_1}}");
    expect(await vault.set("robert\n  CHEN", "PERSON")).toBe("{{PERSON_1}}");
    expect(await vault.set(NAME_2, "PERSON")).toBe("{{PERSON_2}}");
    expect(await vault.set(SSN, "SSN")).toBe("{{SSN_1}}");
    expect(await vault.get("{{PERSON_1}}")).toBe(NAME);
    expect(await vault.tokenFor(" robert chen ", "PERSON")).toBe("{{PERSON_1}}");
    expect(await vault.tokenFor(NAME, "SSN")).toBeUndefined();
    expect(await vault.get("{{PERSON_9}}")).toBeUndefined();
    expect(await vault.get("not a token")).toBeUndefined();
  });

  it("matches InMemoryVault token for token, including LITERAL values stored without folding (ADR 0002)", async () => {
    const ops: [string, string][] = [
      [NAME, "PERSON"],
      ["{{ssn_1}}", LITERAL_CATEGORY],
      [SSN, "SSN"],
      ["{{SSN_1}}", LITERAL_CATEGORY],
      ["{{ SSN_1 }}", LITERAL_CATEGORY],
      ["ROBERT CHEN", "PERSON"],
      ["{{ssn_1}}", LITERAL_CATEGORY],
      [EMAIL, "EMAIL"],
    ];
    const mem = new InMemoryVault();
    const redis = vaultOn(new FakeRedis());
    for (const [value, category] of ops) expect(await redis.set(value, category)).toBe(mem.set(value, category));
    const sort = (es: { token: string }[]) => [...es].sort((a, b) => a.token.localeCompare(b.token));
    expect(sort(await redis.entries())).toEqual(sort(mem.entries()));
    expect(await redis.get("{{LITERAL_2}}")).toBe("{{SSN_1}}");
  });

  it("rejects invalid categories and empty values without echoing the value", async () => {
    const vault = vaultOn(new FakeRedis());
    const e1 = await errorOf(vault.set(NAME, "person:x"));
    expect(e1).toBeInstanceOf(TypeError);
    expectValueFree(e1.message);
    await expect(vault.set("", "PERSON")).rejects.toThrow(TypeError);
  });
});

describe("RedisVault: storage layout and encryption at rest", () => {
  it("stores ciphertext in t: fields and an HMAC (never the value) in v: field names", async () => {
    const redis = new FakeRedis();
    const vault = vaultOn(redis);
    await vault.set(NAME, "PERSON");
    await vault.set(SSN, "SSN");
    const raw = redis.raw(KEY);
    const fields = Object.keys(raw).sort();
    expect(fields.filter((f) => f.startsWith("n:"))).toEqual(["n:PERSON", "n:SSN"]);
    const g = raw["g"] ?? "";
    expect(g).toMatch(/^[0-9a-f]{32}$/);
    expect(fields.filter((f) => f.startsWith("t:"))).toEqual([`t:${g}:{{PERSON_1}}`, `t:${g}:{{SSN_1}}`]);
    for (const f of fields.filter((f) => f.startsWith("v:"))) expect(f).toMatch(/^v:(PERSON|SSN):[0-9a-f]{64}$/);
    for (const f of fields.filter((f) => f.startsWith("t:"))) expect(raw[f]).toMatch(/^v1\./);
    expectValueFree(JSON.stringify(raw));
    expect(JSON.stringify(raw)).not.toContain("123456789");
  });

  it("round-trips through a custom cipher and passes the key|token context", async () => {
    const contexts: string[] = [];
    const rot: VaultCipher = {
      encrypt: (p, c) => (contexts.push(c), `enc:${[...p].reverse().join("")}`),
      decrypt: (c) => [...c.slice(4)].reverse().join(""),
    };
    const redis = new FakeRedis();
    const vault = vaultOn(redis, { cipher: rot });
    await vault.set(NAME, "PERSON");
    const g = await vault.generation();
    expect(contexts).toEqual([`${KEY}|${g}|{{PERSON_1}}`]);
    expect(redis.raw(KEY)[`t:${g}:{{PERSON_1}}`]).toBe(`enc:${[...NAME].reverse().join("")}`);
    expect(await vault.get("{{PERSON_1}}")).toBe(NAME);
  });

  it('stores clear text only with the explicit cipher: "plaintext" opt-out; there is no default', async () => {
    const redis = new FakeRedis();
    await vaultOn(redis, { cipher: "plaintext" }).set(NAME, "PERSON");
    expect(redis.raw(KEY)[`t:${redis.raw(KEY)["g"]}:{{PERSON_1}}`]).toBe(NAME);
    // v: stays keyed even in plaintext mode.
    expect(Object.keys(redis.raw(KEY)).join()).not.toContain("robert");

    const { cipher: _omit, ...noCipher } = { client: redis, requestId: REQ, indexKey: INDEX_KEY, cipher: "plaintext" };
    expect(() => new RedisVault(noCipher as unknown as RedisVaultOptions)).toThrow(/cipher is required/);
  });

  it("requires an index key of at least 16 bytes, or an HMAC function used for every lookup field", async () => {
    const redis = new FakeRedis();
    expect(() => vaultOn(redis, { indexKey: new Uint8Array(8) })).toThrow(/indexKey/);
    const hmac = (m: string) => createHmac("sha256", "test-index-secret").update(m).digest("base64url");
    const vault = vaultOn(redis, { indexKey: hmac });
    await vault.set(NAME, "PERSON");
    const expected = `v:PERSON:${hmac(`${KEY}\u0000${await vault.generation()}\u0000PERSON\u0000${NAME.toLowerCase()}`)}`;
    expect(redis.raw(KEY)[expected]).toBe("{{PERSON_1}}");
  });

  it("rejects a ciphertext moved to another token (AAD binding), with a value-free error", async () => {
    const redis = new FakeRedis();
    const vault = vaultOn(redis);
    await vault.set(NAME, "PERSON");
    await vault.set(NAME_2, "PERSON");
    const g = await vault.generation();
    redis.poke(KEY, `t:${g}:{{PERSON_2}}`, redis.raw(KEY)[`t:${g}:{{PERSON_1}}`] ?? "");
    const error = await errorOf(vault.get("{{PERSON_2}}"));
    expect(error).toBeInstanceOf(VaultIntegrityError);
    expect(error.message).toContain("{{PERSON_2}}");
    expectValueFree(error.message);
  });

  it("refuses to load with the wrong cipher key or index key", async () => {
    const redis = new FakeRedis();
    await vaultOn(redis).set(NAME, "PERSON");
    const wrongCipher = await errorOf(loadVault(vaultOn(redis, { cipher: createAesGcmCipher(new Uint8Array(32)) })));
    expect(wrongCipher).toBeInstanceOf(VaultIntegrityError);
    const wrongIndex = await errorOf(loadVault(vaultOn(redis, { indexKey: new Uint8Array(32).fill(1) })));
    expect(wrongIndex).toBeInstanceOf(VaultIntegrityError);
    expect(wrongIndex.message).toMatch(/lookup field/);
    expectValueFree(wrongCipher.message + wrongIndex.message);
  });

  it("detects a lookup field pointing at the wrong token", async () => {
    const redis = new FakeRedis();
    const vault = vaultOn(redis, { cipher: "plaintext" });
    await vault.set(NAME, "PERSON");
    await vault.set(NAME_2, "PERSON");
    const field = Object.keys(redis.raw(KEY)).find((f) => redis.raw(KEY)[f] === "{{PERSON_1}}") ?? "";
    redis.poke(KEY, field, "{{PERSON_2}}");
    const error = await errorOf(vault.snapshot());
    expect(error).toBeInstanceOf(VaultIntegrityError);
    expectValueFree(error.message);
  });
});

describe("RedisVault: concurrency", () => {
  it("two writers racing on the same value converge on one token; the burned number leaves a gap", async () => {
    const redis = new FakeRedis();
    const a = vaultOn(redis);
    const b = vaultOn(redis);
    // Both writers have taken a counter number before either claims the lookup field.
    barrier(redis, "hSetNX", "v:", 2);
    const [ta, tb] = await Promise.all([a.set(NAME, "PERSON"), b.set("ROBERT CHEN", "PERSON")]);
    redis.onCall = undefined;
    expect(ta).toBe(tb);
    expect(redis.raw(KEY)["n:PERSON"]).toBe("2");
    const tokens = Object.keys(redis.raw(KEY)).filter((f) => f.startsWith("t:"));
    expect(tokens).toHaveLength(1);

    // The next value skips the burned number.
    expect(await a.set(NAME_2, "PERSON")).toBe("{{PERSON_3}}");
    const entries = await a.entries();
    expect(entries.map((e) => e.token).sort()).toEqual([ta, "{{PERSON_3}}"].sort());

    // Plain hydrate still insists on dense numbering; loadVault tolerates gaps and honours the counter.
    const dense = await errorOf(() => hydrate(entries));
    expect(dense.message).toMatch(/gaps/);
    const local = await loadVault(b);
    expect(local.get("{{PERSON_3}}")).toBe(NAME_2);
    expect(local.set("Dana Okafor", "PERSON")).toBe("{{PERSON_4}}");
    expect(local.set("robert chen", "PERSON")).toBe(ta);
  });

  it("many concurrent writers of one value produce exactly one token and one stored value", async () => {
    const redis = new FakeRedis();
    const writers = Array.from({ length: 8 }, () => vaultOn(redis));
    barrier(redis, "hSetNX", "v:", 8);
    const tokens = await Promise.all(writers.map((w, i) => w.set(i % 2 ? NAME : NAME.toUpperCase(), "PERSON")));
    expect(new Set(tokens).size).toBe(1);
    expect(Object.keys(redis.raw(KEY)).filter((f) => f.startsWith("t:"))).toHaveLength(1);
    expect(redis.raw(KEY)["n:PERSON"]).toBe("8");
  });

  it("repairs a writer that crashed between claiming the lookup field and writing the value", async () => {
    const redis = new FakeRedis();
    const vault = vaultOn(redis);
    redis.onCall = (m, _k, field) => {
      if (m === "hSetNX" && field?.startsWith("t:")) throw new Error("connection reset");
    };
    await expect(vault.set(NAME, "PERSON")).rejects.toThrow("connection reset");
    redis.onCall = undefined;
    const snap = await vault.snapshot();
    expect(snap.entries).toEqual([]);
    expect(snap.pending).toBe(1);
    expect(await vault.get("{{PERSON_1}}")).toBeUndefined();

    // The next writer of the same value fills the missing t: field instead of allocating again.
    expect(await vaultOn(redis).set(NAME, "PERSON")).toBe("{{PERSON_1}}");
    expect(await vault.get("{{PERSON_1}}")).toBe(NAME);
    expect((await vault.snapshot()).pending).toBe(0);
  });

  it("persistVault reports a conflict when another process allocated first, and withVault retries to a consistent result", async () => {
    const redis = new FakeRedis();
    const remoteA = vaultOn(redis);
    const remoteB = vaultOn(redis);
    const localA = await loadVault(remoteA);
    const localB = await loadVault(remoteB);
    expect(maskAll([`Claimant Mr. ${NAME} called.`], { vault: localA }).masked[0]).toContain("{{PERSON_1}}");
    expect(maskAll([`Witness Ms. ${NAME_2} called.`], { vault: localB }).masked[0]).toContain("{{PERSON_1}}");
    expect(await persistVault(localA, remoteA)).toEqual({ written: 1 });

    const conflict = await errorOf(persistVault(localB, remoteB));
    expect(conflict).toBeInstanceOf(VaultConflictError);
    expect((conflict as VaultConflictError).counts).toEqual({ PERSON: 1 });
    expectValueFree(conflict.message);

    let attempts = 0;
    const { result: masked } = await withVault(remoteB, (vault) => {
      attempts++;
      return maskAll([`Witness Ms. ${NAME_2} called.`], { vault }).masked[0] ?? "";
    });
    expect(attempts).toBe(1); // NAME_2 was written under {{PERSON_2}} during the failed persist
    expect(masked).toBe("Witness Ms. {{PERSON_2}} called.");
    expect(await remoteA.get("{{PERSON_2}}")).toBe(NAME_2);
  });

  it("withVault re-runs the masking function when a concurrent writer interferes", async () => {
    const redis = new FakeRedis();
    const remote = vaultOn(redis);
    const other = vaultOn(redis);
    let attempts = 0;
    const { result: masked } = await withVault(remote, async (vault) => {
      attempts++;
      if (attempts === 1) await other.set("Dana Okafor", "PERSON"); // lands between load and persist
      return maskAll([`Claimant Mr. ${NAME} called.`], { vault }).masked[0] ?? "";
    });
    // Attempt 1 numbered NAME {{PERSON_1}} locally, but the store had given that to the other writer.
    expect(attempts).toBe(2);
    expect(masked).toBe("Claimant Mr. {{PERSON_2}} called.");
    expect(await remote.get("{{PERSON_2}}")).toBe(NAME);
  });
});

describe("RedisVault: TTL", () => {
  it("sets the TTL on the first write and refreshes it on every write", async () => {
    const redis = new FakeRedis();
    const vault = vaultOn(redis);
    await vault.set(NAME, "PERSON");
    expect(redis.ttl(KEY)).toBe(300);
    redis.advance(200);
    await vault.set(SSN, "SSN");
    expect(redis.ttl(KEY)).toBe(300);
    redis.advance(200);
    await vault.set(NAME, "PERSON"); // existing value: still a write path (t: repair), still refreshed
    expect(redis.ttl(KEY)).toBe(300);
    redis.advance(301);
    expect(redis.keys()).toEqual([]);
    expect(await vault.get("{{PERSON_1}}")).toBeUndefined();
    expect(await vault.entries()).toEqual([]);
  });

  it("never writes a value to a key that has no TTL", async () => {
    const redis = new FakeRedis();
    redis.onCall = (m, key, field) => {
      if (m === "hSetNX" && field?.startsWith("t:")) expect(redis.ttl(key)).toBeGreaterThan(0);
    };
    const vault = vaultOn(redis);
    await vault.set(NAME, "PERSON");
    redis.advance(299);
    await vault.set(NAME, "PERSON");
    expect(redis.log.indexOf("expire")).toBeLessThan(redis.log.indexOf("hSetNX t:"));
  });

  it("refreshes the TTL on reads by default (idle timeout), and not when disabled", async () => {
    const redis = new FakeRedis();
    await vaultOn(redis, { ttlSeconds: 60 }).set(NAME, "PERSON");
    redis.advance(50);
    await vaultOn(redis, { ttlSeconds: 60, refreshTtlOnRead: false }).get("{{PERSON_1}}");
    expect(redis.ttl(KEY)).toBe(10);
    await loadVault(vaultOn(redis, { ttlSeconds: 60 }));
    expect(redis.ttl(KEY)).toBe(60);
    expect(() => vaultOn(redis, { ttlSeconds: 0 })).toThrow(/ttlSeconds/);
  });

  it("clear() deletes the hash", async () => {
    const redis = new FakeRedis();
    const vault = vaultOn(redis);
    await vault.set(NAME, "PERSON");
    await vault.clear();
    expect(redis.keys()).toEqual([]);
    expect(await vault.get("{{PERSON_1}}")).toBeUndefined();
  });
});

describe("RedisVault: gateway pattern across processes", () => {
  it("process A masks and persists; process B loads by request id and unmasks the model reply", async () => {
    const redis = new FakeRedis();
    const note = `Claimant Mr. ${NAME}, SSN ${SSN}, email ${EMAIL}. ${NAME} reported the loss.`;

    // Process A (gateway): mask, persist, enqueue only masked text.
    const processA = createRedisVault({ client: redis, requestId: REQ, cipher: createAesGcmCipher(CIPHER_KEY), indexKey: INDEX_KEY });
    const {
      result: [masked = ""],
      generation,
    } = await withVault(processA, (vault) => maskAll([note], { vault }).masked);
    expectValueFree(masked);
    expectValueFree(JSON.stringify(redis.raw(KEY)));

    // The model replies with placeholders only.
    const reply = `Contact {{PERSON_1}} at {{EMAIL_1}}; verify {{SSN_1}}.`;

    // Process B (worker): separate instance, same request id.
    const processB = createRedisVault({ client: redis, requestId: REQ, cipher: createAesGcmCipher(CIPHER_KEY), indexKey: INDEX_KEY });
    const local = await loadVault(processB, { generation }); // generation travels with the masked text
    expect(unmask(reply, local).text).toBe(`Contact ${NAME} at ${EMAIL}; verify ${SSN}.`);
    await processB.clear();
    expect(redis.keys()).toEqual([]);
  });

  it("keeps a conversation vault stable across processes with wrapAnthropic", async () => {
    const redis = new FakeRedis();
    const seen: string[] = [];
    const model = new FakeAnthropic((p: TestParams) => {
      seen.push(JSON.stringify(p));
      return textMessage("Updated {{PERSON_1}}.");
    });
    const turn = async (text: string) => {
      const remote = vaultOn(redis); // a fresh "process" each turn
      const local = await loadVault(remote);
      const gated = wrapAnthropic(model, { createVault: () => local });
      const res = await gated.messages.create({ model: "m", messages: [{ role: "user", content: text }] });
      await persistVault(local, remote);
      return textOf(res);
    };
    expect(await turn(`Claimant Mr. ${NAME} called.`)).toBe(`Updated ${NAME}.`);
    expect(await turn(`Witness Ms. ${NAME_2}. Claimant Mr. ${NAME} again.`)).toBe(`Updated ${NAME}.`);
    expect(seen[1]).toContain("Witness Ms. {{PERSON_2}}. Claimant Mr. {{PERSON_1}}");
    expectValueFree(seen.join("\n"));
  });
});

describe("RedisVault: no values in logs or errors", () => {
  it("toJSON, util.inspect and String() reveal neither values, keys nor the client", async () => {
    const vault = vaultOn(new FakeRedis());
    await vault.set(NAME, "PERSON");
    expect(JSON.stringify({ vault })).toBe('{"vault":{"store":"redis","ttlSeconds":300}}');
    const shown = inspect(vault, { depth: 10, showHidden: true });
    expectValueFree(shown);
    expect(shown).not.toContain(REQ);
  });

  it("validates the client and names the missing method", () => {
    const noDel = { hGet: async () => null, hSetNX: async () => 1, hIncrBy: async () => 1, hGetAll: async () => ({}), expire: async () => 1 };
    expect(() => vaultOn(noDel as unknown as RedisLike)).toThrow(/client\.del/);
  });

  it("accepts node-redis v4 style replies (booleans, undefined)", async () => {
    const redis = new FakeRedis();
    const v4: RedisLike = {
      hGet: async (k, f) => (await redis.hGet(k, f)) ?? undefined,
      hSetNX: async (k, f, v) => (await redis.hSetNX(k, f, v)) === 1,
      hIncrBy: (k, f, by) => redis.hIncrBy(k, f, by),
      hGetAll: (k) => redis.hGetAll(k),
      expire: async (k, s) => (await redis.expire(k, s)) === 1,
      del: (k) => redis.del(k),
    };
    barrier(redis, "hSetNX", "v:", 2);
    const [x, y] = await Promise.all([vaultOn(v4).set(NAME, "PERSON"), vaultOn(v4).set(NAME, "PERSON")]);
    expect(x).toBe(y);
    redis.onCall = undefined;
    expect(await vaultOn(v4).set(NAME_2, "PERSON")).toBe("{{PERSON_3}}");
  });

  it("adapts an ioredis-shaped client in six lines", async () => {
    // Structural stand-in for ioredis' lowercase API (Promise<string | null>, Promise<number>).
    interface IoredisLike {
      hget(key: string, field: string): Promise<string | null>;
      hsetnx(key: string, field: string, value: string): Promise<number>;
      hincrby(key: string, field: string, increment: number): Promise<number>;
      hgetall(key: string): Promise<Record<string, string>>;
      expire(key: string, seconds: number): Promise<number>;
      del(...keys: string[]): Promise<number>;
    }
    const fake = new FakeRedis();
    const io: IoredisLike = {
      hget: (k, f) => fake.hGet(k, f),
      hsetnx: (k, f, v) => fake.hSetNX(k, f, v),
      hincrby: (k, f, by) => fake.hIncrBy(k, f, by),
      hgetall: (k) => fake.hGetAll(k),
      expire: (k, s) => fake.expire(k, s),
      del: (...keys) => Promise.all(keys.map((k) => fake.del(k))).then((n) => n.reduce((a, b) => a + b, 0)),
    };
    const client: RedisLike = {
      hGet: (k, f) => io.hget(k, f),
      hSetNX: (k, f, v) => io.hsetnx(k, f, v),
      hIncrBy: (k, f, by) => io.hincrby(k, f, by),
      hGetAll: (k) => io.hgetall(k),
      expire: (k, s) => io.expire(k, s),
      del: (k) => io.del(k),
    };
    const vault = vaultOn(client);
    expect(await vault.set(NAME, "PERSON")).toBe("{{PERSON_1}}");
    expect(await vault.get("{{PERSON_1}}")).toBe(NAME);
  });
});

describe("RedisVault: review fixes", () => {
  const lookupFields = (redis: FakeRedis, key: string) => Object.keys(redis.raw(key)).filter((f) => f.startsWith("v:"));

  it("1. refuses to persist into a hash that expired and was recreated after the load (no wrong-person restore)", async () => {
    const redis = new FakeRedis();
    await vaultOn(redis).set(NAME, "PERSON"); // {{PERSON_1}} = NAME
    const remoteA = vaultOn(redis);
    const localA = await loadVault(remoteA);
    const generation = generationOf(localA);
    expect(generation).toMatch(/^[0-9a-f]{32}$/);
    const [maskedA = ""] = maskAll([`Claimant Mr. ${NAME} and witness Ms. ${NAME_2}.`], { vault: localA }).masked;
    expect(maskedA).toBe("Claimant Mr. {{PERSON_1}} and witness Ms. {{PERSON_2}}.");

    redis.advance(301); // TTL lapses during the model call
    await vaultOn(redis).set("Dana Okafor", "PERSON"); // another writer: {{PERSON_1}} = Dana in a new hash

    const error = await errorOf(persistVault(localA, remoteA));
    expect(error).toBeInstanceOf(VaultExpiredError);
    expectValueFree(error.message);
    expect(await vaultOn(redis).get("{{PERSON_2}}")).toBeUndefined(); // nothing of A's was written

    // Process B, given A's generation, refuses rather than restoring {{PERSON_1}} as Dana.
    const b = await errorOf(loadVault(vaultOn(redis), generation === undefined ? {} : { generation }));
    expect(b).toBeInstanceOf(VaultExpiredError);
  });

  it("1. detects the lapse even when the persist has nothing new to write", async () => {
    const redis = new FakeRedis();
    await vaultOn(redis).set(NAME, "PERSON");
    const remote = vaultOn(redis);
    const local = await loadVault(remote);
    maskAll([`Claimant Mr. ${NAME}.`], { vault: local });
    redis.advance(301);
    await vaultOn(redis).set("Dana Okafor", "PERSON");
    await expect(persistVault(local, remote)).rejects.toBeInstanceOf(VaultExpiredError);
  });

  it("1. withVault recovers from a lapse by reloading and masking again", async () => {
    const redis = new FakeRedis();
    await vaultOn(redis).set(NAME, "PERSON");
    const remote = vaultOn(redis);
    let attempts = 0;
    const { result: masked } = await withVault(remote, async (vault) => {
      if (++attempts === 1) {
        redis.advance(301);
        await vaultOn(redis).set("Dana Okafor", "PERSON");
      }
      return maskAll([`Witness Ms. ${NAME_2}.`], { vault }).masked[0] ?? "";
    });
    expect(attempts).toBe(2);
    expect(masked).toBe("Witness Ms. {{PERSON_2}}.");
    expect(await remote.get("{{PERSON_1}}")).toBe("Dana Okafor");
    expect(await remote.get("{{PERSON_2}}")).toBe(NAME_2);
  });

  it("2. a key that expires between EXPIRE and the lookup write never keeps a value without a TTL, or a readable one", async () => {
    for (const stage of ["v:", "t:"]) {
      const redis = new FakeRedis();
      await vaultOn(redis).set(SSN, "SSN");
      let fired = false;
      redis.onCall = (m, _k, field) => {
        if (!fired && m === "hSetNX" && field?.startsWith(stage)) {
          fired = true;
          redis.advance(301);
        }
      };
      const error = await errorOf(vaultOn(redis).set(NAME, "PERSON"));
      expect(error).toBeInstanceOf(VaultExpiredError);
      expect(redis.ttl(KEY)).toBe(300); // the recreated orphan got its TTL from the seal
      expect(await vaultOn(redis).snapshot()).toMatchObject({ entries: [], generation: undefined });
    }
  });

  it("1. a writer stalled past the TTL fails without deleting the successor hash", async () => {
    const redis = new FakeRedis();
    await vaultOn(redis).set(SSN, "SSN"); // generation G1
    const paused = gate();
    const resume = gate();
    const stalled = vaultOn(
      proc(redis, async (m, f) => {
        if (m === "hSetNX" && f?.startsWith("v:")) {
          paused.open();
          await resume.p;
        }
      }),
    );
    const pending = stalled.set(NAME, "PERSON");
    await paused.p;
    redis.advance(301); // G1 expires while the writer is stalled
    const c = await withVault(vaultOn(redis), (v) => maskAll([`Witness Ms. ${NAME_2}.`], { vault: v }).masked[0] ?? "");
    resume.open();
    await expect(pending).rejects.toBeInstanceOf(VaultExpiredError);

    const snap = await vaultOn(redis).snapshot();
    expect(snap.generation).toBe(c.generation);
    expect(snap.stale).toBe(1); // the stalled writer's G1 value, inert
    const local = await loadVault(vaultOn(redis), { generation: c.generation });
    expect(unmask(c.result, local).text).toBe(`Witness Ms. ${NAME_2}.`);
  });

  it("2. an explicit generation: undefined (A stored nothing) expects no hash", async () => {
    const redis = new FakeRedis();
    const a = await withVault(vaultOn(redis), (v) => maskAll(["No personal data here."], { vault: v }).masked[0] ?? "");
    expect(a.generation).toBeUndefined();
    // No hash: an empty vault, and a placeholder-shaped reply stays as written.
    const empty = await loadVault(vaultOn(redis), { generation: a.generation });
    expect(unmask("Ask {{PERSON_1}}.", empty).text).toBe("Ask {{PERSON_1}}.");
    // Another writer then creates a hash under the same id: B refuses it instead of restoring its values.
    await vaultOn(redis).set(NAME, "PERSON");
    await expect(loadVault(vaultOn(redis), { generation: a.generation })).rejects.toBeInstanceOf(VaultExpiredError);
    await expect(loadVault(vaultOn(redis), { generation: null })).rejects.toBeInstanceOf(VaultExpiredError);
    expect((await loadVault(vaultOn(redis), {})).get("{{PERSON_1}}")).toBe(NAME); // key omitted: no check
  });

  it("2. re-arms the TTL after the final write of every set", async () => {
    const redis = new FakeRedis();
    await vaultOn(redis).set(NAME, "PERSON");
    const log = redis.log.join(",");
    expect(log.lastIndexOf("expire")).toBeGreaterThan(log.lastIndexOf("hSetNX"));
    expect(redis.ttl(KEY)).toBe(300);
  });

  it("2/3. residual window: an orphan left by a crash before EXPIRE is never readable, and is adopted with a TTL", async () => {
    const redis = new FakeRedis();
    await vaultOn(redis).set(SSN, "SSN");
    let phase = 0;
    redis.onCall = (m, _k, field) => {
      if (phase === 0 && m === "hSetNX" && field?.startsWith("v:")) {
        phase = 1;
        redis.advance(301); // key lapses; the next writes recreate it without a TTL or generation
      } else if (phase === 1 && m === "expire") {
        throw new Error("process killed");
      }
    };
    await expect(vaultOn(redis).set(NAME, "PERSON")).rejects.toThrow("process killed");
    redis.onCall = undefined;
    expect(redis.ttl(KEY)).toBe(-1); // the documented residual: PII on a key with no TTL
    expect(redis.raw(KEY)["g"]).toBeUndefined();
    const orphan = await vaultOn(redis).snapshot();
    expect(orphan).toMatchObject({ entries: [], generation: undefined, stale: 1 });

    // A different value adopts the hash under a new generation; the orphan's value stays unreadable.
    expect(await vaultOn(redis).set(NAME_2, "PERSON")).toBe("{{PERSON_1}}");
    expect(redis.ttl(KEY)).toBe(300);
    const local = await loadVault(vaultOn(redis));
    expect(local.entries().map((e) => e.value)).toEqual([NAME_2]);
    // Counter collisions with the orphan's token numbers are harmless: its fields are in another generation.
    for (const v of ["Dana Okafor", "Lee Park", NAME]) await vaultOn(redis).set(v, "PERSON");
    expect((await vaultOn(redis).snapshot()).entries).toHaveLength(4);
    expect(await vaultOn(redis).get("{{PERSON_1}}")).toBe(NAME_2);
  });

  it("3. the same value gets unrelated lookup fields under different request ids", async () => {
    const redis = new FakeRedis();
    await vaultOn(redis, { requestId: "req-a" }).set(SSN, "SSN");
    await vaultOn(redis, { requestId: "req-b" }).set(SSN, "SSN");
    const a = lookupFields(redis, "pii-gate:vault:req-a");
    const b = lookupFields(redis, "pii-gate:vault:req-b");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).not.toBe(b[0]);
  });

  it("1a. a writer that saw no generation adopts the one a concurrent writer created (no DEL of a live vault)", async () => {
    const redis = new FakeRedis();
    const pausedB = gate();
    const resumeB = gate();
    // B pauses right after reading `g` (missing: no hash yet).
    const b = vaultOn(
      proc(redis, async (m, f, i) => {
        if (i === 0 && m === "hGet" && f === "g") {
          pausedB.open();
          await resumeB.p;
        }
      }),
    );
    const pending = b.set(NAME, "PERSON");
    await pausedB.p;
    const a = vaultOn(redis);
    expect(await a.set(NAME, "PERSON")).toBe("{{PERSON_1}}");
    const genA = await a.generation();
    resumeB.open();
    expect(await pending).toBe("{{PERSON_1}}");
    expect(await a.generation()).toBe(genA);
    expect(await a.get("{{PERSON_1}}")).toBe(NAME);
  });

  it("1a. two withVault callers racing on a new key never mis-bind tokens (README pattern with generation)", async () => {
    const redis = new FakeRedis();
    const pausedB = gate();
    const resumeB = gate();
    let armed = true;
    const bClient = proc(redis, async (m, f) => {
      if (armed && m === "hIncrBy") {
        armed = false;
        pausedB.open();
        await resumeB.p;
      }
    });
    const bRun = withVault(vaultOn(bClient), (v) => maskAll([`Claimant Mr. ${NAME}. Witness Ms. ${NAME_2}.`], { vault: v }).masked[0]);
    await pausedB.p; // B loaded an empty store and is persisting
    const a = await withVault(vaultOn(redis), (v) => maskAll([`Claimant Mr. ${NAME}. Witness Mr. Lee Park.`], { vault: v }).masked[0]);
    resumeB.open();
    const b = await bRun;
    expect(a.result).toBe("Claimant Mr. {{PERSON_1}}. Witness Mr. {{PERSON_2}}.");
    expect(a.generation).toBeDefined();
    expect(b.generation).toBe(a.generation);
    const store = await loadVault(vaultOn(redis), { generation: a.generation });
    expect(unmask(a.result ?? "", store).text).toBe(`Claimant Mr. ${NAME}. Witness Mr. Lee Park.`);
    expect(unmask(b.result ?? "", store).text).toBe(`Claimant Mr. ${NAME}. Witness Ms. ${NAME_2}.`);
  });

  it("1b. the allocation winner accepts a concurrent repair of its token by a writer of the same value", async () => {
    const redis = new FakeRedis();
    const pausedA = gate();
    const resumeA = gate();
    const a = vaultOn(
      proc(redis, async (m, f) => {
        if (m === "hSetNX" && f?.startsWith("t:")) {
          pausedA.open();
          await resumeA.p;
        }
      }),
    );
    const pending = a.set(NAME, "PERSON");
    await pausedA.p; // A won the lookup field and is about to write the value
    expect(await vaultOn(redis).set("robert  CHEN", "PERSON")).toBe("{{PERSON_1}}"); // B repairs it
    resumeA.open();
    expect(await pending).toBe("{{PERSON_1}}");
    expect(redis.keys()).toEqual([KEY]);
    expect(await vaultOn(redis).get("{{PERSON_1}}")).toBe("robert  CHEN"); // first spelling written wins
  });

  it("1b. a winner whose fresh token holds a different value drops the vault (fail closed)", async () => {
    const redis = new FakeRedis();
    const plain = { cipher: "plaintext" as const };
    await vaultOn(redis, plain).set(SSN, "SSN");
    const g = redis.raw(KEY)["g"] ?? "";
    redis.poke(KEY, `t:${g}:{{PERSON_1}}`, "someone else"); // corrupt: value without a lookup field
    const error = await errorOf(vaultOn(redis, plain).set(NAME, "PERSON"));
    expect(error).toBeInstanceOf(VaultIntegrityError);
    expectValueFree(error.message);
    expect(redis.keys()).toEqual([]);
  });

  it("3. ciphertext and lookup fields are bound to the generation (no replay into a recreated hash)", async () => {
    const redis = new FakeRedis();
    const vault = vaultOn(redis);
    await vault.set(NAME, "PERSON");
    const old = redis.raw(KEY);
    const g1 = old["g"] ?? "";
    await vault.clear();
    await vault.set(NAME_2, "PERSON");
    const g2 = redis.raw(KEY)["g"] ?? "";
    // Replay the old ciphertext under the new generation's field name for the same token number.
    redis.poke(KEY, `t:${g2}:{{PERSON_2}}`, old[`t:${g1}:{{PERSON_1}}`] ?? "");
    const err = await errorOf(vault.get("{{PERSON_2}}"));
    expect(err).toBeInstanceOf(VaultIntegrityError);
    expect(Object.keys(redis.raw(KEY)).filter((f) => f.startsWith("v:"))).not.toContain(
      Object.keys(old).find((f) => f.startsWith("v:")),
    );
  });

  it("4. validates maxAttempts and keeps cipher errors (which may quote input) off thrown errors", async () => {
    const redis = new FakeRedis();
    for (const maxAttempts of [0, -1, Number.NaN, 1.5]) {
      await expect(withVault(vaultOn(redis), () => 1, { maxAttempts })).rejects.toThrow(/maxAttempts/);
    }
    const leaky: VaultCipher = {
      encrypt: (p) => {
        throw new Error(`cannot encrypt ${p}`);
      },
      decrypt: (c) => {
        throw new Error(`cannot decrypt ${c}`);
      },
    };
    const enc = await errorOf(vaultOn(redis, { cipher: leaky }).set(NAME, "PERSON"));
    expect(enc).toBeInstanceOf(VaultIntegrityError);
    expect(enc.cause).toBeUndefined();
    expectValueFree(inspect(enc));
    // The failed set burned {{PERSON_1}} (its lookup stays pending), so this is {{PERSON_2}}.
    expect(await vaultOn(redis, { cipher: "plaintext" }).set(NAME_2, "PERSON")).toBe("{{PERSON_2}}");
    const dec = await errorOf(vaultOn(redis, { cipher: leaky }).get("{{PERSON_2}}"));
    expect(dec.cause).toBeUndefined();
    expectValueFree(inspect(dec));
  });

  it("generation ids are written once per hash and change when the hash is recreated", async () => {
    const redis = new FakeRedis();
    const vault = vaultOn(redis);
    await vault.set(NAME, "PERSON");
    const g1 = await vault.generation();
    await vault.set(NAME_2, "PERSON");
    expect(await vault.generation()).toBe(g1);
    await vault.clear();
    await vault.set(NAME, "PERSON");
    expect(await vault.generation()).not.toBe(g1);
    await expect(vault.setInGeneration(SSN, "SSN", g1)).rejects.toBeInstanceOf(VaultExpiredError);
  });
});
