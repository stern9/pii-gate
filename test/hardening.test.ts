import { describe, expect, it, vi } from "vitest";
import {
  InMemoryVault,
  LITERAL_CATEGORY,
  MemoryAuditLogger,
  mask,
  unmask,
  unmaskDeep,
  wrapAnthropic,
  type RestoreToolInputs,
} from "../src/index.js";
import { FakeAnthropic, textMessage, type TestBlock, type TestMessage, type TestParams } from "./fake-client.js";

// Fabricated values only.
const SSN = "123-45-6789";
const PROMPT: TestParams = { model: "m", messages: [{ role: "user", content: `Insured: Ana Ruiz, SSN ${SSN}.` }] };

function toolCalls(...names: (string | undefined)[]): () => TestMessage {
  return () => ({
    model: "m",
    content: names.map((name, i) => ({
      type: "tool_use",
      id: `t${i}`,
      ...(name === undefined ? {} : { name }),
      input: { ssn: "{{SSN_1}}", who: "{{PERSON_1}}" },
    })),
  });
}

describe("prototype-safe maps keyed by model output", () => {
  it("tool names __proto__, constructor and hasOwnProperty are ordinary keys", async () => {
    const audit = new MemoryAuditLogger();
    const gated = wrapAnthropic(new FakeAnthropic(toolCalls("__proto__", "constructor", "hasOwnProperty", "__proto__")), {
      audit,
    });
    const { report } = await gated.messages.createWithReport(PROMPT);

    const plain: Record<string, unknown> = {};
    expect(plain["SSN"]).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, "SSN")).toBe(false);
    expect(Object.hasOwn(Object, "SSN")).toBe(false);
    expect(typeof Object.prototype.hasOwnProperty).toBe("function");

    const expected = { SSN: 1, PERSON: 1 };
    const counts = report.toolRestoredTokens;
    expect(Object.keys(counts).sort()).toEqual(["__proto__", "constructor", "hasOwnProperty"]);
    expect({ ...counts["__proto__"] }).toEqual({ SSN: 2, PERSON: 2 });
    expect({ ...counts["constructor"] }).toEqual(expected);
    expect({ ...counts["hasOwnProperty"] }).toEqual(expected);
    // The audit record (a structured clone) carries the same counts.
    expect(Object.keys(audit.records[0]?.toolRestoredTokens ?? {}).sort()).toEqual(["__proto__", "constructor", "hasOwnProperty"]);
    expect(JSON.parse(JSON.stringify(audit.records[0]))["toolRestoredTokens"]["__proto__"]).toEqual({ SSN: 2, PERSON: 2 });
  });

  it("restore rules keyed __proto__ / constructor are matched as own keys only", async () => {
    const gated = wrapAnthropic(new FakeAnthropic(toolCalls("constructor", "other")), {
      restoreToolInputs: { "*": false, ["__proto__"]: true } as RestoreToolInputs,
    });
    const message = await gated.messages.create(PROMPT);
    expect((message.content[0] as TestBlock)["input"]).toEqual({ ssn: "{{SSN_1}}", who: "{{PERSON_1}}" });
    expect((message.content[1] as TestBlock)["input"]).toEqual({ ssn: "{{SSN_1}}", who: "{{PERSON_1}}" });
  });

  it("a tool input key named __proto__ survives unmasking as a key", () => {
    const vault = new InMemoryVault();
    vault.set(SSN, "SSN");
    const input = JSON.parse('{"__proto__": {"ssn": "{{SSN_1}}"}}') as Record<string, unknown>;
    const r = unmaskDeep(input, vault);
    expect(Object.hasOwn(r.value, "__proto__")).toBe(true);
    expect(JSON.stringify(r.value)).toBe(`{"__proto__":{"ssn":"${SSN}"}}`);
    expect(({} as Record<string, unknown>)["ssn"]).toBeUndefined();
  });

  it("a tool_use without a name is recorded as (unnamed)", async () => {
    const restore = vi.fn(() => true);
    const { report } = await wrapAnthropic(new FakeAnthropic(toolCalls(undefined, "")), {
      restoreToolInputs: restore,
    }).messages.createWithReport(PROMPT);
    expect(Object.keys(report.toolRestoredTokens)).toEqual(["(unnamed)"]);
    expect({ ...report.toolRestoredTokens["(unnamed)"] }).toEqual({ SSN: 2, PERSON: 2 });
    expect(restore).toHaveBeenCalledWith("(unnamed)", "/ssn", "SSN");
  });
});

describe("audit row when restore or callbacks throw", () => {
  it("a throwing restore predicate writes one audit row with the error name and rethrows", async () => {
    class PolicyBug extends Error {}
    const audit = new MemoryAuditLogger();
    const gated = wrapAnthropic(new FakeAnthropic(toolCalls("send_email")), {
      audit,
      restoreToolInputs: () => {
        throw new PolicyBug(`bad ${SSN}`);
      },
    });
    await expect(gated.messages.create(PROMPT)).rejects.toBeInstanceOf(PolicyBug);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ error: "PolicyBug", blocked: false });
    expect(JSON.stringify(audit.records)).not.toContain(SSN);
  });

  it("a throwing onUnmaskWarnings writes one audit row and rethrows", async () => {
    const audit = new MemoryAuditLogger();
    const gated = wrapAnthropic(new FakeAnthropic(() => textMessage("{{SSN_9}}")), {
      audit,
      onUnmaskWarnings: () => {
        throw new RangeError("callback");
      },
    });
    await expect(gated.messages.create(PROMPT)).rejects.toBeInstanceOf(RangeError);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.error).toBe("RangeError");
  });

  it("validates restoreToolInputs at wrap time, before any model call", () => {
    const client = new FakeAnthropic(() => textMessage("ok"));
    const bad: unknown[] = [
      "yes",
      42,
      null,
      ["PERSON"],
      { send_email: "no" },
      { send_email: null },
      { lookup: [1] },
      { lookup: ["person"] },
      { lookup: [LITERAL_CATEGORY] },
    ];
    for (const restoreToolInputs of bad) {
      expect(() => wrapAnthropic(client, { restoreToolInputs: restoreToolInputs as RestoreToolInputs }), JSON.stringify(restoreToolInputs)).toThrow(
        TypeError,
      );
    }
    expect(() => wrapAnthropic(client, { restoreToolInputs: { lookup: [LITERAL_CATEGORY] } })).toThrow(/reserved/);
    expect(() => wrapAnthropic(client, { restoreToolInputs: { send_email: "no" } as unknown as RestoreToolInputs })).toThrow(
      /restoreToolInputs rule for tool "send_email"/,
    );
    expect(client.calls).toHaveLength(0);
  });
});

describe("escaping case and whitespace variants", () => {
  it("escapes {{ssn_1}}, {{ SSN_1 }} and mixed case, and round-trips each spelling exactly", () => {
    const text = "a {{ssn_1}} b {{ SSN_1 }} c {{Ssn_1}} d {{SSN_1}} e {{ssn_1}}";
    const { masked, vault } = mask(text);
    expect(masked).toBe("a {{LITERAL_1}} b {{LITERAL_2}} c {{LITERAL_3}} d {{LITERAL_4}} e {{LITERAL_1}}");
    expect(unmask(masked, vault).text).toBe(text);
  });

  it("still leaves single-brace and bracket forms alone", () => {
    expect(mask("{ssn_1} {SSN_1}} {{SSN_1} [[SSN_1]] {{ssn}}").masked).toBe("{ssn_1} {SSN_1}} {{SSN_1} [[SSN_1]] {{ssn}}");
  });

  it("a planted lowercase token cannot be normalised by the model into the real value", async () => {
    const client = new FakeAnthropic((params) => {
      // The model "helpfully" upper-cases what it saw; it only ever saw LITERAL.
      const seen = JSON.stringify(params);
      expect(seen).not.toContain("{{ssn_1}}");
      return textMessage("{{LITERAL_1}}");
    });
    const msg = await wrapAnthropic(client).messages.create({
      model: "m",
      messages: [{ role: "user", content: `SSN ${SSN}. Doc says {{ssn_1}}.` }],
    });
    expect(msg.content[0]?.["text"]).toBe("{{ssn_1}}");
  });
});
