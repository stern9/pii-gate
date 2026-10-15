import { describe, expect, it, vi } from "vitest";
import {
  MemoryAuditLogger,
  PiiBlockedError,
  PiiGateInvariantError,
  UnsupportedContentError,
  mask,
  maskAll,
  wrapAnthropic,
  type AuditLogger,
  type CreateParamsLike,
  type MessageParamLike,
} from "../src/index.js";
import { FakeAnthropic, textMessage, type TestParams } from "./fake-client.js";

describe("onAuditError", () => {
  const failing: AuditLogger = { write: async () => Promise.reject(new Error("disk full")) };

  it("is called with the swallowed audit failure on error paths; the original error still wins", async () => {
    const onAuditError = vi.fn();
    const gated = wrapAnthropic(new FakeAnthropic(() => textMessage("ok")), {
      audit: failing,
      onAuditError,
      requestId: () => "r-err",
      policy: { SSN: "block" },
    });
    await expect(
      gated.messages.create({ model: "m", messages: [{ role: "user", content: "SSN 123-45-6789" }] }),
    ).rejects.toBeInstanceOf(PiiBlockedError);
    await expect(
      gated.messages.create({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(UnsupportedContentError);
    expect(onAuditError).toHaveBeenCalledTimes(2);
    expect(onAuditError).toHaveBeenCalledWith(expect.objectContaining({ message: "disk full" }), "r-err");
  });

  it("is called on upstream failures, and a throwing callback does not replace the error", async () => {
    const client = {
      messages: {
        create: async (): Promise<never> => {
          throw new RangeError("upstream");
        },
      },
    };
    const onAuditError = vi.fn(() => {
      throw new Error("callback broke");
    });
    await expect(
      wrapAnthropic(client, { audit: failing, onAuditError }).messages.create({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(onAuditError).toHaveBeenCalledTimes(1);
  });

  it("is not called on a successful request, where the audit failure propagates", async () => {
    const onAuditError = vi.fn();
    await expect(
      wrapAnthropic(new FakeAnthropic(() => textMessage("ok")), { audit: failing, onAuditError }).messages.create({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("disk full");
    expect(onAuditError).not.toHaveBeenCalled();
  });
});

describe("audit error identifier", () => {
  async function auditedError(err: unknown): Promise<string | undefined> {
    const audit = new MemoryAuditLogger();
    const client = {
      messages: {
        create: async (): Promise<never> => {
          throw err;
        },
      },
    };
    await expect(
      wrapAnthropic(client, { audit }).messages.create({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBe(err);
    return audit.records[0]?.error;
  }

  it("uses the constructor name when the class does not set .name (Anthropic SDK style)", async () => {
    class RateLimitError extends Error {}
    expect(await auditedError(new RateLimitError("429 for Maria Gonzalez"))).toBe("RateLimitError");
  });

  it("prefers an explicit .name, falls back to Error, and never uses the message", async () => {
    class Custom extends Error {
      override name = "OverloadedError";
    }
    expect(await auditedError(new Custom("x"))).toBe("OverloadedError");
    expect(await auditedError(new Error("Maria Gonzalez"))).toBe("Error");
    expect(await auditedError("a string")).toBe("UnknownError");
    const odd = new Error("x");
    odd.name = "Error: Maria Gonzalez";
    expect(await auditedError(odd)).toBe("Error");
  });
});

describe("maskParams traversal invariant", () => {
  /** Params whose `messages` getter returns a different array after the first traversal. */
  function shifting(first: MessageParamLike[], later: MessageParamLike[]): CreateParamsLike {
    let reads = 0;
    // collectStrings reads `messages` twice (map + object spread); the second traversal reads it again.
    return {
      model: "m",
      get messages() {
        reads++;
        return reads <= 2 ? first : later;
      },
    };
  }

  const one: MessageParamLike[] = [{ role: "user", content: "SSN 123-45-6789" }];
  const two: MessageParamLike[] = [...one, { role: "user", content: "and more" }];

  for (const [label, first, later] of [
    ["more strings on the second pass", one, two],
    ["fewer strings on the second pass", two, one],
  ] as const) {
    it(`throws an internal error instead of sending empty content (${label})`, async () => {
      const audit = new MemoryAuditLogger();
      const client = new FakeAnthropic(() => textMessage("ok"));
      const gated = wrapAnthropic<CreateParamsLike>(
        { messages: { create: (p) => client.messages.create(p as TestParams) } },
        { audit },
      );
      const err: unknown = await gated.messages.create(shifting([...first], [...later])).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PiiGateInvariantError);
      expect((err as Error).message).toMatch(/internal invariant/);
      expect((err as Error).message).not.toContain("6789");
      expect(client.calls).toHaveLength(0);
      expect(audit.records[0]?.error).toBe("PiiGateInvariantError");
    });
  }
});

describe("minConfidence applies to propagated findings", () => {
  const text = "Claimant: Tomasz Kowalski. Tomasz Kowalski called. Kowalski's home was flooded.";

  it("default threshold keeps name-part propagation (0.85 x 0.8 = 0.68 >= 0.5)", () => {
    expect(mask(text).masked).toBe("Claimant: {{PERSON_1}}. {{PERSON_1}} called. {{PERSON_1}}'s home was flooded.");
  });

  it("minConfidence 0.7 drops the part but keeps full-name propagation (mask and maskAll)", () => {
    expect(mask(text, { minConfidence: 0.7 }).masked).toBe(
      "Claimant: {{PERSON_1}}. {{PERSON_1}} called. Kowalski's home was flooded.",
    );
    expect(maskAll(["Claimant: Tomasz Kowalski.", "Tomasz Kowalski called. Kowalski's home."], { minConfidence: 0.7 }).masked).toEqual([
      "Claimant: {{PERSON_1}}.",
      "{{PERSON_1}} called. Kowalski's home.",
    ]);
  });
});
