import { describe, expect, it } from "vitest";
import { InMemoryVault, PiiBlockedError, mask, maskAll } from "../src/index.js";

const TEXT = "Insured: Maria Gonzalez, SSN 123-45-6789, email maria@example.com.";

describe("policy", () => {
  it("throws PiiBlockedError when a blocked category is present", () => {
    expect(() => mask(TEXT, { policy: { SSN: "block" } })).toThrow(PiiBlockedError);
  });

  it("lists categories and counts but never values in the error", () => {
    try {
      mask(`${TEXT} Again: 123-45-6789`, { policy: { SSN: "block", EMAIL: "block" } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PiiBlockedError);
      const e = err as PiiBlockedError;
      expect(e.categories).toEqual(["EMAIL", "SSN"]);
      expect(e.counts).toEqual({ EMAIL: 1, SSN: 2 });
      expect(`${e.message} ${JSON.stringify(e)}`).not.toContain("123-45-6789");
    }
  });

  it("blocks before issuing any tokens into a shared vault", () => {
    const vault = new InMemoryVault();
    expect(() => maskAll(["Insured: Ana Ruiz", "SSN 123-45-6789"], { vault, policy: { SSN: "block" } })).toThrow(
      PiiBlockedError,
    );
    expect(vault.size).toBe(0);
  });

  it("does not throw when the blocked category is absent", () => {
    expect(() => mask("Insured: Maria Gonzalez", { policy: { SSN: "block" } })).not.toThrow();
  });

  it("allow leaves the category untouched but still reports it", () => {
    const { masked, findings, vault } = mask(TEXT, { policy: { EMAIL: "allow" } });
    expect(masked).toBe("Insured: {{PERSON_1}}, SSN {{SSN_1}}, email maria@example.com.");
    expect(findings.find((f) => f.category === "EMAIL")).toMatchObject({ action: "allow", value: "maria@example.com" });
    expect(findings.find((f) => f.category === "EMAIL")?.token).toBeUndefined();
    expect(vault.entries().map((e) => e.category)).not.toContain("EMAIL");
  });

  it("supports a default action with per-category overrides", () => {
    const { masked } = mask(TEXT, { defaultAction: "allow", policy: { SSN: "mask" } });
    expect(masked).toBe("Insured: Maria Gonzalez, SSN {{SSN_1}}, email maria@example.com.");
  });

  it("applies policy to schema-hint categories", () => {
    expect(() =>
      mask("Member ID ZX-99812 on file", {
        schemaHints: { memberId: { value: "ZX-99812", category: "MEMBER_ID" } },
        policy: { MEMBER_ID: "block" },
      }),
    ).toThrow(PiiBlockedError);
  });
});
