import { describe, expect, it, vi } from "vitest";
import {
  InMemoryVault,
  MemoryAuditLogger,
  NerDetectorError,
  PiiBlockedError,
  defaultDetectors,
  mask,
  maskAll,
  maskAllAsync,
  maskAsync,
  nerDetector,
  unmask,
  wrapAnthropic,
  type AsyncDetector,
  type Detector,
  type NerEntity,
  type NerFailure,
} from "../src/index.js";
import { FakeAnthropic, textMessage, textOf } from "./fake-client.js";
import { fakeRecognize, fakeRecognizeAsync } from "./fake-ner.js";
import { loadFixtures } from "./helpers.js";

/* All names, numbers and addresses here are fabricated. */

const NAMES = ["jordan ellery", "dana whitlock"];
const withNer = (ner: AsyncDetector): AsyncDetector[] => [...defaultDetectors(), ner];
const fixed = (entities: NerEntity[]) => (): NerEntity[] => entities;

/** Findings of an NER-only detector over `text`, as [value, category] pairs. */
async function nerValues(text: string, entities: NerEntity[], extra: Partial<Parameters<typeof nerDetector>[0]> = {}) {
  const det = nerDetector({ recognize: fixed(entities), ...extra });
  const found = await det.detect(text);
  return found.map((f) => [f.value, f.category]);
}

describe("nerDetector: closes the uncued-name gap", () => {
  it("masks an uncued, lowercase name that regex misses", async () => {
    const text = "spoke with jordan ellery about the estimate";
    expect(mask(text).masked).toBe(text);

    const ner = nerDetector({ recognize: fakeRecognizeAsync(NAMES) });
    const { masked, vault, findings } = await maskAsync(text, { detectors: withNer(ner) });
    expect(masked).toBe("spoke with {{PERSON_1}} about the estimate");
    expect(findings).toMatchObject([{ category: "PERSON", detector: "ner", action: "mask", token: "{{PERSON_1}}" }]);
    expect(unmask("Call {{PERSON_1}} back.", vault).text).toBe("Call jordan ellery back.");
  });

  it("a synchronous recognizer yields a plain Detector usable with sync mask()", () => {
    const ner: Detector = nerDetector({ recognize: fakeRecognize(NAMES) });
    const { masked } = mask("Left a message for dana whitlock.", { detectors: [...defaultDetectors(), ner] });
    expect(masked).toBe("Left a message for {{PERSON_1}}.");
  });

  it("accepts word-only entities (no offsets) and masks every whole-word occurrence", async () => {
    const ner = nerDetector({ recognize: fakeRecognizeAsync(NAMES, { wordOnly: true }) });
    const { masked } = await maskAsync("jordan ellery called; Jordan Ellery's file. jordan elleryx", { detectors: withNer(ner) });
    expect(masked).toBe("{{PERSON_1}} called; {{PERSON_1}}'s file. jordan elleryx");
  });

  it("reports detector name and category for the audit", async () => {
    const ner = nerDetector({ name: "hf-ner", recognize: fakeRecognize(NAMES) });
    expect(ner.categories).toEqual(["PERSON"]);
    const { findings } = await maskAsync("with dana whitlock", { detectors: [ner] });
    expect(findings[0]).toMatchObject({ detector: "hf-ner", category: "PERSON" });
  });
});

describe("nerDetector: label mapping", () => {
  const text = "jordan ellery drove from austin";
  const entities: NerEntity[] = [
    { label: "PER", start: 0, end: 13, score: 0.95 },
    { label: "LOC", start: 25, end: 31, score: 0.95 },
  ];

  it("maps PER/PERSON (any case, BIO prefixes ignored) to PERSON and drops other labels by default", async () => {
    expect(await nerValues(text, entities)).toEqual([["jordan ellery", "PERSON"]]);
    for (const label of ["per", "B-PER", "I-PER", "person", "S-PERSON"]) {
      expect(await nerValues(text, [{ label, start: 0, end: 6, score: 0.9 }])).toEqual([["jordan", "PERSON"]]);
    }
    expect(await nerValues(text, [{ label: "ORG", start: 0, end: 13, score: 0.99 }])).toEqual([]);
  });

  it("custom labels replace the defaults", async () => {
    const labels = { LOC: "LOCATION" };
    expect(await nerValues(text, entities, { labels })).toEqual([["austin", "LOCATION"]]);
    expect(nerDetector({ recognize: fixed([]), labels: { PER: "PERSON", GPE: "LOCATION" } }).categories).toEqual([
      "PERSON",
      "LOCATION",
    ]);
  });

  it("merges adjacent B-PER / I-PER tokens into one name", async () => {
    const tokens: NerEntity[] = [
      { label: "B-PER", start: 11, end: 17, score: 0.9 },
      { label: "I-PER", start: 18, end: 24, score: 0.8 },
    ];
    expect(await nerValues("spoke with jordan ellery today", tokens)).toEqual([["jordan ellery", "PERSON"]]);
  });

  it("rejects invalid or reserved categories at construction", () => {
    expect(() => nerDetector({ recognize: fixed([]), labels: { PER: "LITERAL" } })).toThrow(/reserved/);
    expect(() => nerDetector({ recognize: fixed([]), labels: { PER: "person" } })).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => nerDetector({ recognize: fixed([]), labels: {} })).toThrow(/at least one/);
    expect(() => nerDetector({ recognize: fixed([]), minScore: 2 })).toThrow(/minScore/);
    expect(() => nerDetector({ recognize: fixed([]), timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => nerDetector({ recognize: fixed([]), concurrency: 1.5 })).toThrow(/concurrency/);
  });
});

describe("nerDetector: minScore", () => {
  const text = "met jordan ellery";
  const at = (score: number | undefined): NerEntity[] => [{ label: "PER", start: 4, end: 17, score }];

  it("drops entities below the default 0.7, keeps those at or above", async () => {
    expect(await nerValues(text, at(0.69))).toEqual([]);
    expect(await nerValues(text, at(0.7))).toEqual([["jordan ellery", "PERSON"]]);
  });

  it("honours a custom minScore and uses the score as confidence", async () => {
    expect(await nerValues(text, at(0.6), { minScore: 0.55 })).toEqual([["jordan ellery", "PERSON"]]);
    const det = nerDetector({ recognize: fixed(at(0.91)) });
    expect((await det.detect(text))[0]?.confidence).toBe(0.91);
  });

  it("accepts unscored entities at confidence 0.8; drops non-finite scores", async () => {
    const det = nerDetector({ recognize: fixed(at(undefined)), minScore: 0.95 });
    expect(await det.detect(text)).toMatchObject([{ value: "jordan ellery", confidence: 0.8 }]);
    expect(await nerValues(text, at(Number.NaN))).toEqual([]);
  });

  it("findings below mask's minConfidence are still cut off by mask", async () => {
    const ner = nerDetector({ recognize: fixed(at(0.6)), minScore: 0.5 });
    const { masked } = await maskAsync(text, { detectors: [ner], minConfidence: 0.65 });
    expect(masked).toBe(text);
  });
});

describe("nerDetector: span validation (precision)", () => {
  const text = "Spoke with jordan ellery, 555 12, re: B.";

  it("drops out-of-bounds, empty, reversed, negative and non-integer spans", async () => {
    const bad: NerEntity[] = [
      { label: "PER", start: 11, end: 999, score: 0.9 },
      { label: "PER", start: 11, end: 11, score: 0.9 },
      { label: "PER", start: 24, end: 11, score: 0.9 },
      { label: "PER", start: -3, end: 4, score: 0.9 },
      { label: "PER", start: 11.5, end: 17, score: 0.9 },
    ];
    expect(await nerValues(text, bad)).toEqual([]);
  });

  it("drops malformed entries without throwing", async () => {
    const junk = [null, 7, "PER", { start: 11, end: 24 }, { label: 3, start: 11, end: 24 }] as unknown as NerEntity[];
    expect(await nerValues(text, junk)).toEqual([]);
  });

  it("falls back to `word` when offsets do not match the text (e.g. code-point offsets)", async () => {
    const emoji = "🚗 spoke with jordan ellery";
    // Code-point offsets: 14..27 in Python, 15..28 in UTF-16.
    const entity: NerEntity = { label: "PER", start: 14, end: 27, word: "jordan ellery", score: 0.9 };
    expect(await nerValues(emoji, [entity])).toEqual([["jordan ellery", "PERSON"]]);
    // A tokenizer piece is not a usable word: the offsets are used (and grown to whole words).
    expect(await nerValues(emoji, [{ ...entity, word: "##llery" }])).toEqual([["jordan ellery", "PERSON"]]);
    // Offsets without a word are taken as given.
    expect(await nerValues(text, [{ label: "PER", start: 11, end: 24, score: 0.9 }])).toEqual([["jordan ellery", "PERSON"]]);
  });

  it("matches `word` ignoring case and whitespace (uncased models)", async () => {
    const entity: NerEntity = { label: "PER", start: 0, end: 14, word: "jordan  ellery", score: 0.9 };
    expect(await nerValues("Jordan Ellery called", [entity])).toEqual([["Jordan Ellery", "PERSON"]]);
  });

  it("trims punctuation and whitespace at the edges and grows sub-word spans to whole words", async () => {
    expect(await nerValues(text, [{ label: "PER", start: 10, end: 25, score: 0.9 }])).toEqual([["jordan ellery", "PERSON"]]);
    // A sub-word token ("jor") must not leave the rest of the name visible.
    expect(await nerValues(text, [{ label: "PER", start: 11, end: 14, score: 0.9 }])).toEqual([["jordan", "PERSON"]]);
  });

  it("drops single-letter, digit-only and stop-word spans", async () => {
    const spans: NerEntity[] = [
      { label: "PER", start: 26, end: 32, score: 0.99 }, // "555 12"
      { label: "PER", start: 38, end: 39, score: 0.99 }, // "B"
    ];
    expect(await nerValues(text, spans)).toEqual([]);
    expect(await nerValues("Claimant: tbd", [{ label: "PER", start: 0, end: 8, score: 0.99 }])).toEqual([]);
    expect(await nerValues("Dear Sir", [{ label: "PER", start: 0, end: 4, score: 0.99 }])).toEqual([]);
  });

  it("requireCapitalized keeps only capitalised spans", async () => {
    const entities: NerEntity[] = [
      { label: "PER", start: 0, end: 6, score: 0.9 },
      { label: "PER", start: 11, end: 15, score: 0.9 },
    ];
    expect(await nerValues("Jordan and dana", entities)).toEqual([["Jordan", "PERSON"], ["dana", "PERSON"]]);
    expect(await nerValues("Jordan and dana", entities, { requireCapitalized: true })).toEqual([["Jordan", "PERSON"]]);
  });
});

describe("nerDetector: interaction with the pipeline", () => {
  it("overlap with regex: longest span wins, then confidence", async () => {
    const text = "Insured: Maria Gonzalez called.";
    const regexOnly = mask(text).findings;
    expect(regexOnly).toMatchObject([{ value: "Maria Gonzalez", detector: "person" }]);

    // Same span, higher score: NER wins the tie on confidence; still one PERSON.
    const same = nerDetector({ recognize: fixed([{ label: "PER", start: 9, end: 23, score: 0.99 }]) });
    const a = await maskAsync(text, { detectors: withNer(same) });
    expect(a.findings).toMatchObject([{ value: "Maria Gonzalez", detector: "ner" }]);
    expect(a.masked).toBe("Insured: {{PERSON_1}} called.");

    // Shorter NER span ("Maria"): the longer regex span wins.
    const shorter = nerDetector({ recognize: fixed([{ label: "PER", start: 9, end: 14, score: 0.99 }]) });
    const b = await maskAsync(text, { detectors: withNer(shorter) });
    expect(b.findings).toMatchObject([{ value: "Maria Gonzalez", detector: "person" }]);
  });

  it("schema hints win over NER spans that overlap them", async () => {
    const ner = nerDetector({ recognize: fakeRecognize(["jordan ellery"]) });
    const { findings } = await maskAsync("spoke with jordan ellery", {
      detectors: [ner],
      schemaHints: { insured: { value: "jordan ellery", category: "INSURED_NAME" } },
    });
    expect(findings).toMatchObject([{ category: "INSURED_NAME", detector: "schema:insured" }]);
  });

  it("never touches placeholder-shaped input: LITERAL escaping wins", async () => {
    const text = "note for {{PERSON_1}}";
    const ner = nerDetector({ recognize: fixed([{ label: "PER", start: 11, end: 19, score: 0.99 }]) });
    const { masked, findings } = await maskAsync(text, { detectors: [ner] });
    expect(masked).toBe("note for {{LITERAL_1}}");
    expect(findings.map((f) => f.category)).toEqual(["LITERAL"]);
  });

  it("an NER-found name seeds propagation to uncased and other-text mentions", async () => {
    // The stub only recognises the exact lowercase spelling; propagation finds the rest.
    const ner = nerDetector({ recognize: fakeRecognizeAsync(["jordan ellery"], { caseSensitive: true }) });
    const { masked } = await maskAllAsync(
      ["spoke with jordan ellery at the shop", "Jordan Ellery called back", "JORDAN ELLERY signed"],
      { detectors: withNer(ner) },
    );
    expect(masked).toEqual(["spoke with {{PERSON_1}} at the shop", "{{PERSON_1}} called back", "{{PERSON_1}} signed"]);
  });

  it("capitalised NER names seed name-part propagation like cued names", async () => {
    const ner = nerDetector({ recognize: fakeRecognize(["Dana Whitlock"], { caseSensitive: true }) });
    const { masked } = await maskAsync("We met Dana Whitlock. Whitlock's car was towed.", { detectors: withNer(ner) });
    expect(masked).toBe("We met {{PERSON_1}}. {{PERSON_1}}'s car was towed.");
  });

  it("maskAllAsync: one vault and numbering across texts", async () => {
    const ner = nerDetector({ recognize: fakeRecognizeAsync(NAMES) });
    const { masked, vault } = await maskAllAsync(
      ["dana whitlock reported it", "Phone: (512) 555-0143", "cc jordan ellery and dana whitlock"],
      { detectors: withNer(ner) },
    );
    expect(masked).toEqual(["{{PERSON_1}} reported it", "Phone: {{PHONE_1}}", "cc {{PERSON_2}} and {{PERSON_1}}"]);
    expect(vault.size).toBe(3);
  });

  it("a block on an NER-found category aborts before any token is issued", async () => {
    const vault = new InMemoryVault();
    const ner = nerDetector({ recognize: fakeRecognizeAsync(NAMES) });
    await expect(
      maskAllAsync(["fine text", "with jordan ellery"], { detectors: withNer(ner), policy: { PERSON: "block" }, vault }),
    ).rejects.toBeInstanceOf(PiiBlockedError);
    expect(vault.size).toBe(0);
  });

  it("allow policy leaves NER names in place but reports them", async () => {
    const ner = nerDetector({ recognize: fakeRecognize(NAMES) });
    const { masked, findings } = await maskAsync("with jordan ellery", { detectors: [ner], policy: { PERSON: "allow" } });
    expect(masked).toBe("with jordan ellery");
    expect(findings).toMatchObject([{ action: "allow", category: "PERSON" }]);
  });
});

describe("nerDetector: failures", () => {
  const text = "spoke with jordan ellery, SSN 123-45-6789";
  const boom = () => {
    throw new Error(`model failed on input: ${text}`);
  };

  it("onError 'throw' (default): rejects with NerDetectorError carrying no text", async () => {
    const failures: NerFailure[] = [];
    const ner = nerDetector({ recognize: async () => boom(), onFailure: (f) => failures.push(f) });
    const err = await maskAsync(text, { detectors: withNer(ner) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NerDetectorError);
    expect(err).toMatchObject({ detector: "ner", reason: "error" });
    expect(String((err as Error).message)).not.toMatch(/jordan|ellery|6789/);
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ detector: "ner", reason: "error" });
  });

  it("onError 'throw' with a synchronous recognizer throws from sync mask()", () => {
    const ner = nerDetector({ recognize: (): NerEntity[] => boom() });
    expect(() => mask(text, { detectors: [...defaultDetectors(), ner] })).toThrow(NerDetectorError);
  });

  it("onError 'skip': continues with regex findings only and reports the failure", async () => {
    const onFailure = vi.fn();
    const ner = nerDetector({ recognize: async () => boom(), onError: "skip", onFailure });
    const { masked } = await maskAsync(text, { detectors: withNer(ner) });
    expect(masked).toBe("spoke with jordan ellery, SSN {{SSN_1}}");
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ reason: "error" }));
  });

  it("an onFailure callback that throws does not change the outcome", async () => {
    const ner = nerDetector({
      recognize: async () => boom(),
      onError: "skip",
      onFailure: () => {
        throw new Error("observer down");
      },
    });
    await expect(maskAsync("x", { detectors: [ner] })).resolves.toMatchObject({ masked: "x" });
  });

  it("invalid output (not an array) is a failure", async () => {
    const ner = nerDetector({ recognize: async () => null as unknown as NerEntity[] });
    await expect(maskAsync(text, { detectors: [ner] })).rejects.toMatchObject({ reason: "invalid-output" });
    const skip = nerDetector({ recognize: async () => ({}) as unknown as NerEntity[], onError: "skip" });
    await expect(maskAsync("ok", { detectors: [skip] })).resolves.toMatchObject({ masked: "ok" });
  });

  it("times out, aborts the signal, and throws or skips", async () => {
    let signal: AbortSignal | undefined;
    const hang = (_t: string, ctx: { signal: AbortSignal }) => {
      signal = ctx.signal;
      return new Promise<NerEntity[]>(() => undefined);
    };
    const ner = nerDetector({ recognize: hang, timeoutMs: 20 });
    await expect(maskAsync(text, { detectors: withNer(ner) })).rejects.toMatchObject({
      name: "NerDetectorError",
      reason: "timeout",
    });
    expect(signal?.aborted).toBe(true);

    const skip = nerDetector({ recognize: hang, timeoutMs: 20, onError: "skip" });
    const { masked } = await maskAsync(text, { detectors: withNer(skip) });
    expect(masked).toBe("spoke with jordan ellery, SSN {{SSN_1}}");
  });

  it("a late rejection after a timeout is swallowed (no unhandled rejection)", async () => {
    const ner = nerDetector({
      recognize: () => new Promise<NerEntity[]>((_, reject) => setTimeout(() => reject(new Error(text)), 40)),
      timeoutMs: 10,
      onError: "skip",
    });
    await maskAsync("x", { detectors: [ner] });
    await new Promise((r) => setTimeout(r, 60));
  });

  it("a fast call finishes before the timeout", async () => {
    const ner = nerDetector({ recognize: fakeRecognizeAsync(NAMES, { delayMs: 1 }), timeoutMs: 1000 });
    const { masked } = await maskAsync("with dana whitlock", { detectors: [ner] });
    expect(masked).toBe("with {{PERSON_1}}");
  });

  it("limits concurrent recognize calls", async () => {
    let active = 0;
    let peak = 0;
    const recognize = async (t: string): Promise<NerEntity[]> => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return fakeRecognize(NAMES)(t);
    };
    const ner = nerDetector({ recognize, concurrency: 2 });
    const texts = Array.from({ length: 7 }, (_, i) => (i % 2 ? "dana whitlock" : "jordan ellery"));
    const { masked } = await maskAllAsync(texts, { detectors: [ner] });
    expect(peak).toBe(2);
    expect(new Set(masked)).toEqual(new Set(["{{PERSON_1}}", "{{PERSON_2}}"]));
  });
});

describe("sync API unchanged", () => {
  it("sync mask/maskAll reject an async detector with a TypeError that names the async API", () => {
    const ner = nerDetector({ recognize: fakeRecognizeAsync(NAMES) });
    const asSync = ner as unknown as Detector;
    expect(() => mask("with jordan ellery", { detectors: [asSync] })).toThrow(/maskAsync/);
    expect(() => maskAll(["with jordan ellery"], { detectors: [asSync] })).toThrow(/maskAsync/);
    try {
      mask("with jordan ellery", { detectors: [asSync] });
    } catch (err) {
      expect(String((err as Error).message)).not.toMatch(/jordan/);
    }
  });

  it("maskAllAsync with only sync detectors equals maskAll on every golden fixture", async () => {
    const texts = loadFixtures().map((fx) => fx.text);
    const sync = maskAll(texts);
    const asyncResult = await maskAllAsync(texts);
    expect(asyncResult.masked).toEqual(sync.masked);
    expect(asyncResult.findings).toEqual(sync.findings);
    expect(asyncResult.vault.entries()).toEqual(sync.vault.entries());
    for (const fx of loadFixtures()) expect((await maskAsync(fx.text)).masked).toBe(mask(fx.text).masked);
  });
});

describe("wrapAnthropic with an async NER detector", () => {
  it("masks NER names in every string before sending, restores them after", async () => {
    const client = new FakeAnthropic(() => textMessage("Please call {{PERSON_1}} and {{PERSON_2}}."));
    const audit = new MemoryAuditLogger();
    const ner = nerDetector({ recognize: fakeRecognizeAsync(NAMES) });
    const gated = wrapAnthropic(client, { detectors: withNer(ner), audit });

    const { message, report } = await gated.messages.createWithReport({
      model: "claude-test",
      system: "Notes may mention dana whitlock.",
      messages: [
        { role: "user", content: "spoke with jordan ellery about the rental" },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "contact: dana whitlock" }] },
      ],
    });
    expect(client.seen()).not.toMatch(/jordan|ellery|dana|whitlock/i);
    expect(textOf(message)).toBe("Please call jordan ellery and dana whitlock.");
    expect(report.categoryCounts).toEqual({ PERSON: 3 });
    expect(audit.records[0]).toMatchObject({ categoryCounts: { PERSON: 3 }, blocked: false });
  });

  it("a failing NER rejects the call before the client is reached, with one audit row", async () => {
    const client = new FakeAnthropic(() => textMessage("unused"));
    const audit = new MemoryAuditLogger();
    const ner = nerDetector({
      recognize: async () => {
        throw new Error("service down");
      },
    });
    const gated = wrapAnthropic(client, { detectors: withNer(ner), audit });
    await expect(
      gated.messages.create({ model: "claude-test", messages: [{ role: "user", content: "with jordan ellery" }] }),
    ).rejects.toBeInstanceOf(NerDetectorError);
    expect(client.calls).toHaveLength(0);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.error).toBe("NerDetectorError");
    expect(JSON.stringify(audit.records)).not.toMatch(/jordan/);
  });
});

describe("async pipeline error paths", () => {
  it("a sync detector throwing while an NER call is in flight rejects cleanly", async () => {
    let rejectLater: ((e: Error) => void) | undefined;
    const ner = nerDetector({
      recognize: () => new Promise<NerEntity[]>((_, reject) => (rejectLater = reject)),
      onError: "skip",
    });
    const broken: Detector = {
      name: "broken",
      categories: ["X"],
      detect: () => {
        throw new RangeError("broken detector");
      },
    };
    await expect(maskAllAsync(["a", "b"], { detectors: [ner, broken] })).rejects.toBeInstanceOf(RangeError);
    rejectLater?.(new Error("late"));
    await new Promise((r) => setTimeout(r, 5));
  });
});

describe("nerDetector: bounded expansion of model output", () => {
  /** The stub recognizers here are synchronous, so failures throw; turn them into rejections. */
  const detectAsync = async (d: AsyncDetector, text: string) => d.detect(text);
  const filler = "xy ".repeat(5000);

  it("duplicate word-only entities are searched once (50,000 x 5,000 finishes fast)", async () => {
    const entities: NerEntity[] = Array.from({ length: 50_000 }, () => ({ label: "PER", word: "xy", score: 0.9 }));
    const det = nerDetector({ recognize: fixed(entities) });
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const found = await det.detect(filler);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(200 * 1024 * 1024);
    expect(found).toHaveLength(5000);
  });

  it("duplicate offset entities collapse to one span", async () => {
    const entities: NerEntity[] = Array.from({ length: 20_000 }, () => ({ label: "PER", start: 4, end: 17, score: 0.9 }));
    expect(await nerValues("met jordan ellery", entities)).toEqual([["jordan ellery", "PERSON"]]);
  });

  it("more word-search spans than the cap is invalid-output (throw or skip)", async () => {
    const text = "ab ".repeat(12_000);
    const entities: NerEntity[] = [{ label: "PER", word: "ab" }];
    const failures: NerFailure[] = [];
    const det = nerDetector({ recognize: fixed(entities), onFailure: (f) => failures.push(f) });
    const started = performance.now();
    await expect(detectAsync(det, text)).rejects.toMatchObject({ reason: "invalid-output" });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(failures).toEqual([{ detector: "ner", reason: "invalid-output" }]);
    const skip = nerDetector({ recognize: fixed(entities), onError: "skip" });
    await expect(detectAsync(skip, text)).resolves.toEqual([]);
  });

  it("distinct words sharing a common first token are anchored on their rarest token", async () => {
    const entities: NerEntity[] = Array.from({ length: 2000 }, (_, i) => ({ label: "PER", word: `xy q${i}` }));
    const det = nerDetector({ recognize: fixed(entities) });
    const started = performance.now();
    await expect(detectAsync(det, filler)).resolves.toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("words made only of very common tokens hit the candidate budget quickly", async () => {
    const text = "xy zz ".repeat(5000);
    // 48 distinct words of 4-5 tokens drawn from {xy, zz}: each anchor has 5,000 candidates.
    const words = [4, 5].flatMap((n) =>
      Array.from({ length: 2 ** n }, (_, bits) => Array.from({ length: n }, (_, k) => ((bits >> k) & 1 ? "xy" : "zz")).join(" ")),
    );
    const det = nerDetector({ recognize: fixed(words.map((word) => ({ label: "PER", word }))) });
    const started = performance.now();
    await expect(detectAsync(det, text)).rejects.toMatchObject({ reason: "invalid-output" });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("too many entities is invalid-output", async () => {
    const entities = Array.from({ length: 100_001 }, () => ({ label: "ORG" }));
    await expect(detectAsync(nerDetector({ recognize: fixed(entities) }), "x")).rejects.toMatchObject({
      reason: "invalid-output",
    });
  });

  it("word search still respects whole words, case and whitespace", async () => {
    const text = "Jordan  Ellery, jordanx ellery, xjordan ellery, jordan ellery.";
    expect(await nerValues(text, [{ label: "PER", word: "jordan ellery" }])).toEqual([
      ["Jordan  Ellery", "PERSON"],
      ["jordan ellery", "PERSON"],
    ]);
  });
});

describe("nerDetector: only BIO continuations merge", () => {
  it("keeps two tagged names apart", async () => {
    const text = "Attendees: Ana Ruiz Bo Li";
    const bio: NerEntity[] = [
      { label: "B-PER", start: 11, end: 14, score: 0.9 },
      { label: "I-PER", start: 15, end: 19, score: 0.9 },
      { label: "B-PER", start: 20, end: 22, score: 0.9 },
      { label: "I-PER", start: 23, end: 25, score: 0.9 },
    ];
    expect(await nerValues(text, bio)).toEqual([
      ["Ana Ruiz", "PERSON"],
      ["Bo Li", "PERSON"],
    ]);
    // Plain (non-BIO) entities next to each other are never joined.
    const plain = bio.map((e) => ({ ...e, label: "PER" }));
    expect((await nerValues(text, plain)).map(([v]) => v)).toEqual(["Ana", "Ruiz", "Bo", "Li"]);
  });

  it("does not continue across E- or into another category", async () => {
    const text = "jordan ellery smith";
    const entities: NerEntity[] = [
      { label: "B-PER", start: 0, end: 6, score: 0.9 },
      { label: "E-PER", start: 7, end: 13, score: 0.9 },
      { label: "I-PER", start: 14, end: 19, score: 0.9 },
    ];
    expect((await nerValues(text, entities)).map(([v]) => v)).toEqual(["jordan ellery", "smith"]);
    const mixed: NerEntity[] = [
      { label: "B-PER", start: 0, end: 6, score: 0.9 },
      { label: "I-LOC", start: 7, end: 13, score: 0.9 },
    ];
    expect(await nerValues(text, mixed, { labels: { PER: "PERSON", LOC: "LOCATION" } })).toEqual([
      ["jordan", "PERSON"],
      ["ellery", "LOCATION"],
    ]);
  });

  it("one-letter pieces are dropped before merging", async () => {
    const entities: NerEntity[] = [
      { label: "B-PER", start: 0, end: 1, score: 0.9 },
      { label: "I-PER", start: 2, end: 3, score: 0.9 },
    ];
    expect(await nerValues("a a went home", entities)).toEqual([]);
  });
});

describe("nerDetector: oversized spans and words never reach a regex (no text in errors)", () => {
  const SECRET = "Zelda Quixote-Fakename";
  const body = Array.from({ length: 6000 }, (_, i) => (i === 3 ? SECRET : `word${i}`)).join(" ");
  const text = `Note: ${body} end.`;
  const start = text.indexOf(body);

  it("drops a span longer than the limit instead of failing in propagation", async () => {
    const ner = nerDetector({ recognize: async () => [{ label: "PER", start, end: start + body.length }] });
    const { masked } = await maskAsync(text, { detectors: withNer(ner) });
    expect(masked).toBe(text);
  });

  it("ignores an oversized word (word-only, or with mismatching offsets) in both onError modes", async () => {
    for (const onError of ["throw", "skip"] as const) {
      const wordOnly = nerDetector({ onError, recognize: async () => [{ label: "PER", word: body }] });
      await expect(maskAsync(text, { detectors: [wordOnly] })).resolves.toMatchObject({ masked: text });
      const mismatch = nerDetector({ onError, recognize: () => [{ label: "PER", start, end: start + body.length, word: `${body} x` }] });
      expect(mask(text, { detectors: [mismatch] }).masked).toBe(text);
    }
  });

  it("a BIO chain stops merging at the limit; every piece is still masked", async () => {
    const words = Array.from({ length: 5000 }, (_, i) => `w${i.toString(36)}x`);
    const chain = words.join(" ");
    let pos = 0;
    const entities: NerEntity[] = words.map((w, i) => {
      const e = { label: i ? "I-PER" : "B-PER", start: pos, end: pos + w.length, score: 0.9 };
      pos += w.length + 1;
      return e;
    });
    const found = await nerDetector({ recognize: fixed(entities) }).detect(chain);
    expect(found.length).toBeGreaterThan(300);
    expect(Math.max(...found.map((f) => f.end - f.start))).toBeLessThanOrEqual(128);
    expect(found.reduce((n, f) => n + f.value.split(" ").length, 0)).toBe(5000);
  });

  it("a schema hint too long to search for fails with a value-free RangeError", () => {
    let err: unknown;
    try {
      mask(`x ${body}`, { schemaHints: { notes: { value: body, category: "PERSON" } } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RangeError);
    expect(String((err as Error).message)).not.toMatch(/Zelda|word1/);
    expect(String((err as Error).stack)).not.toMatch(/Zelda/);
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("an entity whose getters throw is invalid-output, and the thrown text is not passed on", async () => {
    const evil = {
      get label(): string {
        throw new Error(`leak: ${SECRET}`);
      },
    } as unknown as NerEntity;
    const failures: NerFailure[] = [];
    const ner = nerDetector({ recognize: async () => [evil], onFailure: (f) => failures.push(f) });
    await expect(maskAsync("x", { detectors: [ner] })).rejects.toMatchObject({ reason: "invalid-output" });
    expect(failures).toEqual([{ detector: "ner", reason: "invalid-output" }]);
  });
});

describe("nerDetector: ordinary input stays under the caps", () => {
  it("(a) code-point offsets after an emoji: 400 mentions are searched once, not 400 times", async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `Q${i}. MR. KOWALCZYK: I recall the roof was damaged.`);
    const text = `Deposition transcript 📄\n${lines.join("\n")}`;
    const entities: NerEntity[] = [];
    for (let i = text.indexOf("KOWALCZYK"); i !== -1; i = text.indexOf("KOWALCZYK", i + 1)) {
      const cp = [...text.slice(0, i)].length; // Python-style code-point offset
      entities.push({ label: "PER", score: 0.99, start: cp, end: cp + 9, word: "KOWALCZYK" });
    }
    const { masked } = await maskAsync(text, { detectors: withNer(nerDetector({ recognize: fixed(entities) })) });
    expect(masked).not.toContain("KOWALCZYK");
  });

  it("(b) token-level BIO output: 12,000 offset entities on a 100 KB transcript", async () => {
    const text = Array.from({ length: 3000 }, (_, i) => `MR. KOWALCZYK-NOWAK: Answer ${i}.`).join("\n");
    const entities: NerEntity[] = [];
    for (let i = text.indexOf("KOWALCZYK-NOWAK"); i !== -1; i = text.indexOf("KOWALCZYK-NOWAK", i + 1)) {
      for (const [a, b, label] of [[0, 3, "B-PER"], [3, 9, "I-PER"], [9, 10, "I-PER"], [10, 15, "I-PER"]] as const) {
        entities.push({ label, score: 0.98, start: i + a, end: i + b });
      }
    }
    expect(entities).toHaveLength(12_000);
    const started = performance.now();
    const { masked } = await maskAsync(text, { detectors: withNer(nerDetector({ recognize: fixed(entities) })) });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(masked).not.toMatch(/KOWALCZYK|NOWAK/);
  });

  it("(c) word-only names starting with a very common token ('de X' in Spanish text)", async () => {
    const filler = Array.from({ length: 2500 }, (_, i) => `la casa de campo ${i}`).join(". ");
    const names = Array.from({ length: 45 }, (_, i) => `de ${["la Cruz", "Souza", "Leon", "Vega"][i % 4]}${i}`);
    const text = `${filler}. ${names.map((n) => `Habló con ${n}.`).join(" ")}`;
    const ner = nerDetector({ recognize: fixed(names.map((word) => ({ label: "PER", word }))) });
    const { masked } = await maskAsync(text, { detectors: [ner] });
    for (const n of names) expect(masked).not.toContain(n);
    expect(masked).toContain("la casa de campo 0");
  });
});

describe("nerDetector: offsets survive detokenisation differences in `word`", () => {
  const cases: [string, string, string][] = [
    ["Spoke with Jean-Luc Moreau today.", "Jean-Luc Moreau", "Jean - Luc Moreau"], // WordPiece detokenised hyphen
    ["Spoke with José Núñez today.", "José Núñez", "jose nunez"], // uncased model stripped accents
    ["Spoke with Siobhán O’Brien today.", "Siobhán O’Brien", "Siobhán O'Brien"], // quote normalisation
    ["Spoke with Siobhan O'Brien today.", "Siobhan O'Brien", "Siobhan O ' Brien"],
    ["Spoke with jordan ellery today.", "jordan ellery", "Jordan Ellery"],
  ];

  it.each(cases)("%s", async (text, span, word) => {
    const start = text.indexOf(span);
    expect(await nerValues(text, [{ label: "PER", score: 0.99, start, end: start + span.length, word }])).toEqual([
      [span, "PERSON"],
    ]);
    // Word-only output finds the same span.
    expect(await nerValues(text, [{ label: "PER", word }])).toEqual([[span, "PERSON"]]);
  });

  it("NFD text matches an NFC word", async () => {
    const text = "met José Nũñez today";
    expect(await nerValues(text, [{ label: "PER", word: "José Núñez" }])).toEqual([["José Nũñez", "PERSON"]]);
  });

  it("falls back to the offsets when the word is nowhere in the text", async () => {
    const text = "Spoke with Jordan Ellery today.";
    expect(await nerValues(text, [{ label: "PER", start: 11, end: 24, word: "J. Ellery-Smith" }])).toEqual([
      ["Jordan Ellery", "PERSON"],
    ]);
  });

  it("does not join a word across a comma", async () => {
    expect(await nerValues("Ana, Ruiz and Bo", [{ label: "PER", word: "Ana Ruiz" }])).toEqual([]);
  });
});

describe("nerDetector: tokenizer pieces", () => {
  it("rejects WordPiece '##' and byte-level 'Ġ' words; uses offsets when present", async () => {
    const text = "Mark Johnson said her son and Son Ltd will call.";
    expect(await nerValues(text, [{ label: "I-PER", word: "##son" }])).toEqual([]);
    expect(await nerValues(text, [{ label: "PER", word: "Ġjohnson" }])).toEqual([]);
    expect(await nerValues(text, [{ label: "I-PER", word: "##son", start: 9, end: 12 }])).toEqual([["Johnson", "PERSON"]]);
  });

  it("reads a SentencePiece '▁' as a space", async () => {
    expect(await nerValues("spoke with jordan ellery", [{ label: "PER", word: "▁jordan▁ellery" }])).toEqual([
      ["jordan ellery", "PERSON"],
    ]);
  });
});

describe("nerDetector: scripts without spaces, and word characters", () => {
  it("does not grow CJK or Thai offsets to the whole run", async () => {
    const zh = "我是王小明。";
    const s = zh.indexOf("王小明");
    expect(await nerValues(zh, [{ label: "PER", start: s, end: s + 3 }])).toEqual([["王小明", "PERSON"]]);
    const th = "ผมชื่อสมชายครับ";
    const t = th.indexOf("สมชาย");
    expect(await nerValues(th, [{ label: "PER", start: t, end: t + 5 }])).toEqual([["สมชาย", "PERSON"]]);
  });

  it("finds a CJK word inside running text", async () => {
    expect(await nerValues("我是王小明。王小明说。", [{ label: "PER", word: "王小明" }])).toEqual([
      ["王小明", "PERSON"],
      ["王小明", "PERSON"],
    ]);
  });

  it("treats '_' as a word character when growing and searching", async () => {
    expect(await nerValues("user ana_ruiz logged in", [{ label: "PER", start: 5, end: 8 }])).toEqual([["ana_ruiz", "PERSON"]]);
    expect(await nerValues("user ana_ruiz logged in", [{ label: "PER", word: "ana" }])).toEqual([]);
  });
});

describe("detect(): async detectors", () => {
  it("throws the same clear TypeError as mask() instead of dropping a promise", async () => {
    const { detect } = await import("../src/index.js");
    const sneaky = nerDetector({
      recognize: ((t: string) => Promise.resolve(fakeRecognize(NAMES)(t))) as unknown as (t: string) => NerEntity[],
    });
    expect(() => detect("with jordan ellery", { detectors: [sneaky] })).toThrow(/maskAsync/);
  });
});

describe("nerDetector: duplicates and long offsets are rejected before normalisation", () => {
  const text = "Ana Ruiz ".repeat(22_222); // ~200 KB

  it("20,000 identical whole-text entities with an absent word finish quickly", async () => {
    const entities: NerEntity[] = Array.from({ length: 20_000 }, () => ({ label: "PER", start: 0, end: text.length, word: "Zed Quill" }));
    const started = performance.now();
    await nerDetector({ recognize: fixed(entities) }).detect(text);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("20,000 distinct long offset spans finish quickly and yield nothing", async () => {
    const entities: NerEntity[] = Array.from({ length: 20_000 }, (_, i) => ({ label: "PER", start: i, end: text.length - i, word: "Zed Quill" }));
    const started = performance.now();
    expect(await nerDetector({ recognize: fixed(entities) }).detect(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
