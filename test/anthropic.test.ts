import { describe, expect, it, vi } from "vitest";
import {
  MemoryAuditLogger,
  PiiBlockedError,
  UnsupportedContentError,
  wrapAnthropic,
  type AuditLogger,
} from "../src/index.js";
import { FakeAnthropic, textMessage, textOf, type TestMessage, type TestParams } from "./fake-client.js";
import { loadFixtures } from "./helpers.js";

const fixtures = loadFixtures();
const allPii = fixtures.flatMap((fx) => Object.values(fx.expected).flat());

function echoTokens(params: TestParams): TestMessage {
  // A "model" that refers back to every placeholder it received, in text and in a tool call.
  const tokens = [...new Set(JSON.stringify(params).match(/\{\{[A-Z_]+_\d+\}\}/g) ?? [])];
  return {
    model: params.model,
    content: [
      { type: "text", text: `Summary mentions ${tokens.join(", ")}.` },
      { type: "tool_use", id: "tu_1", name: "update_claim", input: { parties: tokens, note: { first: tokens[0] ?? "" } } },
    ],
  };
}

describe("wrapAnthropic", () => {
  it("never sends raw fixture PII to the client, and restores it in the response", async () => {
    const client = new FakeAnthropic(echoTokens);
    const audit = new MemoryAuditLogger();
    const gated = wrapAnthropic(client, { audit, requestId: () => "req-1" });

    const { message, report } = await gated.messages.createWithReport({
      model: "claude-test",
      system: [{ type: "text", text: `Adjuster desk. Reference case: ${fixtures[0]?.text ?? ""}` }],
      messages: fixtures.map((fx, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: i % 3 === 0 ? fx.text : [{ type: "text", text: fx.text }],
      })),
    });

    expect(client.calls).toHaveLength(1);
    const seen = client.seen();
    for (const value of allPii) expect(seen, JSON.stringify(value)).not.toContain(value);
    // Partial leakage check on the most distinctive pieces too.
    for (const piece of ["Gonzalez", "6789", "1HGCM82633A004352", "Kowalski"]) expect(seen).not.toContain(piece);

    const text = textOf(message);
    const input = message.content[1]?.["input"] as { parties: string[] };
    expect(text).toContain("Maria Gonzalez");
    expect(text).toContain("123-45-6789");
    expect(input.parties).toContain("1HGCM82633A004352");
    expect(JSON.stringify(message)).not.toMatch(/\{\{[A-Z_]+_\d+\}\}/);
    expect(report.warnings).toEqual([]);

    const [record] = audit.records;
    expect(record).toMatchObject({ requestId: "req-1", model: "claude-test", blocked: false, unmaskWarnings: 0 });
    // Each token appears once in the text, once in `parties`, plus one more in `note.first`.
    expect(record?.responseReferencedTokens).toBe(report.vault.size * 2 + 1);
    expect(record?.categoryCounts["VIN"]).toBeGreaterThanOrEqual(4);
    expect(record?.latencyMs).toBeGreaterThanOrEqual(0);
    const logged = JSON.stringify(audit.records);
    for (const value of allPii) expect(logged).not.toContain(value);
  });

  it("uses one vault per call, shared across system and messages", async () => {
    const client = new FakeAnthropic(() => textMessage("ok"));
    await wrapAnthropic(client).messages.create({
      model: "m",
      system: "Insured: Ana Ruiz",
      messages: [{ role: "user", content: "Draft a letter to Ana Ruiz." }],
    });
    const sent = client.calls[0];
    expect(sent?.system).toBe("Insured: {{PERSON_1}}");
    expect(sent?.messages[0]?.content).toBe("Draft a letter to {{PERSON_1}}.");
  });

  it("does not mutate the caller's params", async () => {
    const client = new FakeAnthropic(() => textMessage("ok"));
    const params: TestParams = {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "SSN 123-45-6789" }] }],
    };
    const snapshot = structuredClone(params);
    await wrapAnthropic(client).messages.create(params);
    expect(params).toEqual(snapshot);
  });

  it("blocks before calling the client and audits the block", async () => {
    const client = new FakeAnthropic(() => textMessage("ok"));
    const audit = new MemoryAuditLogger();
    const gated = wrapAnthropic(client, { audit, policy: { SSN: "block" } });

    await expect(
      gated.messages.create({ model: "m", messages: [{ role: "user", content: "SSN 123-45-6789" }] }),
    ).rejects.toBeInstanceOf(PiiBlockedError);

    expect(client.calls).toHaveLength(0);
    expect(audit.records[0]).toMatchObject({ blocked: true, blockedCategories: ["SSN"], categoryCounts: { SSN: 1 } });
  });

  it("audits upstream failures by error name only", async () => {
    const audit = new MemoryAuditLogger();
    const client = {
      messages: {
        create: async (): Promise<never> => {
          throw new TypeError("upstream echoed: Maria Gonzalez");
        },
      },
    };
    await expect(
      wrapAnthropic(client, { audit }).messages.create({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(TypeError);
    expect(audit.records[0]?.error).toBe("TypeError");
    expect(JSON.stringify(audit.records)).not.toContain("Maria");
  });

  describe("audits requests rejected before the model call", () => {
    const imageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };

    it("unsupported content block: one record with the error name", async () => {
      const client = new FakeAnthropic(() => textMessage("ok"));
      const audit = new MemoryAuditLogger();
      await expect(
        wrapAnthropic(client, { audit, requestId: () => "r-img" }).messages.create({
          model: "m",
          messages: [{ role: "user", content: [{ type: "text", text: "SSN 123-45-6789" }, imageBlock] }],
        }),
      ).rejects.toBeInstanceOf(UnsupportedContentError);
      expect(client.calls).toHaveLength(0);
      expect(audit.records).toHaveLength(1);
      expect(audit.records[0]).toMatchObject({ requestId: "r-img", model: "m", blocked: false, error: "UnsupportedContentError" });
      expect(JSON.stringify(audit.records)).not.toContain("6789");
    });

    it("stream: true: one record with the error name", async () => {
      const client = new FakeAnthropic(() => textMessage("ok"));
      const audit = new MemoryAuditLogger();
      await expect(
        wrapAnthropic(client, { audit }).messages.create({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toBeInstanceOf(UnsupportedContentError);
      expect(client.calls).toHaveLength(0);
      expect(audit.records).toHaveLength(1);
      expect(audit.records[0]).toMatchObject({ blocked: false, error: "UnsupportedContentError" });
    });

    it("invalid category: one record with the error name only", async () => {
      const client = new FakeAnthropic(() => textMessage("ok"));
      const audit = new MemoryAuditLogger();
      const gated = wrapAnthropic(client, {
        audit,
        schemaHints: { insured: { value: "Ana Ruiz", category: "bad-category" } },
      });
      await expect(
        gated.messages.create({ model: "m", messages: [{ role: "user", content: "Insured: Ana Ruiz" }] }),
      ).rejects.toThrow(TypeError);
      expect(client.calls).toHaveLength(0);
      expect(audit.records).toHaveLength(1);
      expect(audit.records[0]).toMatchObject({ blocked: false, error: "TypeError" });
      const logged = JSON.stringify(audit.records);
      expect(logged).not.toContain("Ruiz");
      expect(logged).not.toContain("bad-category");
    });

    it("blocked requests keep their record shape (no error field)", async () => {
      const audit = new MemoryAuditLogger();
      await expect(
        wrapAnthropic(new FakeAnthropic(() => textMessage("ok")), { audit, policy: { SSN: "block" } }).messages.create({
          model: "m",
          messages: [{ role: "user", content: "SSN 123-45-6789" }],
        }),
      ).rejects.toBeInstanceOf(PiiBlockedError);
      expect(audit.records).toHaveLength(1);
      expect(audit.records[0]).toMatchObject({ blocked: true, blockedCategories: ["SSN"], categoryCounts: { SSN: 1 } });
      expect(audit.records[0]).not.toHaveProperty("error");
    });
  });

  describe("when the audit sink fails", () => {
    const throwingSync: AuditLogger = {
      write: () => {
        throw new Error("disk full");
      },
    };
    const rejectingAsync: AuditLogger = { write: async () => Promise.reject(new Error("disk full")) };

    for (const [label, audit] of [["sync throw", throwingSync], ["async reject", rejectingAsync]] as const) {
      it(`the original error wins on a rejected request (${label})`, async () => {
        const client = new FakeAnthropic(() => textMessage("ok"));
        const gated = wrapAnthropic(client, { audit, policy: { SSN: "block" } });
        await expect(
          gated.messages.create({ model: "m", messages: [{ role: "user", content: [{ type: "image" }] }] }),
        ).rejects.toBeInstanceOf(UnsupportedContentError);
        await expect(
          gated.messages.create({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
        ).rejects.toBeInstanceOf(UnsupportedContentError);
        await expect(
          gated.messages.create({ model: "m", messages: [{ role: "user", content: "SSN 123-45-6789" }] }),
        ).rejects.toBeInstanceOf(PiiBlockedError);
      });
    }

    it("the original error wins on an upstream failure", async () => {
      const client = {
        messages: {
          create: async (): Promise<never> => {
            throw new RangeError("upstream");
          },
        },
      };
      await expect(
        wrapAnthropic(client, { audit: throwingSync }).messages.create({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toBeInstanceOf(RangeError);
    });

    it("still surfaces on a successful request", async () => {
      const client = new FakeAnthropic(() => textMessage("ok"));
      await expect(
        wrapAnthropic(client, { audit: rejectingAsync }).messages.create({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toThrow("disk full");
    });
  });

  it("surfaces unmask warnings through the callback", async () => {
    const onUnmaskWarnings = vi.fn();
    const client = new FakeAnthropic(() => textMessage("Dear {person_1}},"));
    const msg = await wrapAnthropic(client, { onUnmaskWarnings, requestId: () => "r" }).messages.create({
      model: "m",
      messages: [{ role: "user", content: "Insured: Ana Ruiz" }],
    });
    expect(textOf(msg)).toBe("Dear {person_1}},");
    expect(onUnmaskWarnings).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: "near-match", suggestion: "{{PERSON_1}}", path: "/content/0/text" })],
      "r",
    );
  });

  it("passes thinking blocks through untouched", async () => {
    const client = new FakeAnthropic(() => textMessage("ok"));
    const thinking = { type: "thinking", thinking: "SSN 123-45-6789", signature: "sig" };
    await wrapAnthropic(client).messages.create({ model: "m", messages: [{ role: "assistant", content: [thinking] }] });
    expect(client.calls[0]?.messages[0]?.content).toEqual([thinking]);
  });
});
