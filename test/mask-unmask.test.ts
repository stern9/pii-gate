import { describe, expect, it } from "vitest";
import { InMemoryVault, hydrate, mask, maskAll, unmask, unmaskDeep, type JsonValue } from "../src/index.js";
import { loadFixtures } from "./helpers.js";

const NOTE =
  "Insured: Maria Gonzalez, SSN 123-45-6789. Maria Gonzalez called from (512) 555-0198. " +
  "Re-verify SSN 123-45-6789 and email maria@example.com; cc adjuster@example.com.";

describe("mask", () => {
  it("produces typed, numbered placeholders", () => {
    const { masked } = mask(NOTE);
    expect(masked).toBe(
      "Insured: {{PERSON_1}}, SSN {{SSN_1}}. {{PERSON_1}} called from {{PHONE_1}}. " +
        "Re-verify SSN {{SSN_1}} and email {{EMAIL_1}}; cc {{EMAIL_2}}.",
    );
  });

  it("gives repeated values the same token and records each occurrence as a finding", () => {
    const { vault, findings } = mask(NOTE);
    const ssnFindings = findings.filter((f) => f.category === "SSN");
    expect(ssnFindings).toHaveLength(2);
    expect(new Set(ssnFindings.map((f) => f.token))).toEqual(new Set(["{{SSN_1}}"]));
    expect(vault.entries().filter((e) => e.category === "SSN")).toHaveLength(1);
  });

  it("propagates a cued name to its uncued occurrences", () => {
    const { masked } = mask("Claimant: Robert Chen. Later, robert chen called back.");
    expect(masked).toBe("Claimant: {{PERSON_1}}. Later, {{PERSON_1}} called back.");
  });

  it("propagates name parts case-sensitively, leaving ordinary lowercase words alone", () => {
    expect(mask("Claimant: Sarah May. Adjuster may call back. May confirmed.").masked).toBe(
      "Claimant: {{PERSON_1}}. Adjuster may call back. {{PERSON_2}} confirmed.",
    );
    expect(mask("Insured: Robert Bill Chen. Please bill the account. Bill called.").masked).toBe(
      "Insured: {{PERSON_1}}. Please bill the account. {{PERSON_2}} called.",
    );
    expect(maskAll(["Insured: Robert Bill Chen", "Please bill Bill."]).masked).toEqual([
      "Insured: {{PERSON_1}}", "Please bill {{PERSON_2}}.",
    ]);
  });

  it("still masks a capitalized sentence-initial word that matches a name part (documented over-mask)", () => {
    expect(mask("Claimant: Sarah May. May I ask why the adjuster may be late?").masked).toBe(
      "Claimant: {{PERSON_1}}. {{PERSON_2}} I ask why the adjuster may be late?",
    );
  });

  it("propagates accented name parts only in their written case", () => {
    expect(mask("Claimant: Zoë Ángeles. Ángeles signed; the los ángeles office was notified.").masked).toBe(
      "Claimant: {{PERSON_1}}. {{PERSON_2}} signed; the los ángeles office was notified.",
    );
  });

  it("keeps full-name propagation case-insensitive and whitespace-tolerant", () => {
    const { masked } = mask("Claimant: Sarah May. Later, SARAH  MAY and sarah may both appear.");
    expect(masked).toBe("Claimant: {{PERSON_1}}. Later, {{PERSON_1}} and {{PERSON_1}} both appear.");
  });

  it("can disable propagation", () => {
    const { masked } = mask("Claimant: Robert Chen. Later, Robert Chen called back.", { propagate: false });
    expect(masked).toBe("Claimant: {{PERSON_1}}. Later, Robert Chen called back.");
  });

  it("masks schema hints without detection, even where detectors would miss them", () => {
    const { masked, findings } = mask("Spoke with Maria about policy HO-5521; she is at Unit 4.", {
      schemaHints: {
        firstName: { value: "Maria", category: "PERSON" },
        policyNumber: { value: "HO-5521", category: "POLICY_NUMBER" },
        missing: { value: null, category: "PERSON" },
      },
    });
    expect(masked).toBe("Spoke with {{PERSON_1}} about policy {{POLICY_NUMBER_1}}; she is at Unit 4.");
    expect(findings.every((f) => f.confidence === 1)).toBe(true);
  });

  it("lets a schema hint win over an overlapping detector finding", () => {
    const { findings } = mask("Call 512-555-0198", {
      schemaHints: { agencyLine: { value: "512-555-0198", category: "AGENCY_PHONE" } },
    });
    expect(findings.map((f) => f.category)).toEqual(["AGENCY_PHONE"]);
  });

  it("rejects category names that would break placeholder parsing", () => {
    expect(() => mask("x Maria x", { schemaHints: { n: { value: "Maria", category: "person name" } } })).toThrow(
      TypeError,
    );
  });

  it("shares numbering across texts via maskAll", () => {
    const { masked } = maskAll(["Insured: Ana Ruiz, ana@example.com", "Email ana@example.com, ask Ana Ruiz"]);
    expect(masked).toEqual(["Insured: {{PERSON_1}}, {{EMAIL_1}}", "Email {{EMAIL_1}}, ask {{PERSON_1}}"]);
  });

  it("does not leak originals via JSON.stringify of the vault", () => {
    const { vault } = mask(NOTE);
    expect(JSON.stringify(vault)).not.toContain("123-45-6789");
  });
});

describe("unmask round trip", () => {
  it.each(loadFixtures())("restores $file exactly", (fx) => {
    const { masked, vault } = mask(fx.text);
    const { text, warnings } = unmask(masked, vault);
    expect(text).toBe(fx.text);
    expect(warnings).toEqual([]);
  });

  it("restores a model-style response that references tokens", () => {
    const { vault } = mask(NOTE);
    const reply = "Draft: Hi {{PERSON_1}}, we confirmed {{PHONE_1}} and will email {{EMAIL_1}}.";
    expect(unmask(reply, vault)).toEqual({
      text: "Draft: Hi Maria Gonzalez, we confirmed (512) 555-0198 and will email maria@example.com.",
      warnings: [],
      restored: 3,
    });
  });

  it("warns on and keeps unknown well-formed tokens", () => {
    const { vault } = mask(NOTE);
    const r = unmask("See {{PERSON_9}}", vault);
    expect(r.text).toBe("See {{PERSON_9}}");
    expect(r.warnings).toEqual([{ kind: "unknown-token", found: "{{PERSON_9}}", index: 4 }]);
  });

  it("hydrates a vault from persisted entries", () => {
    const { masked, vault } = mask(NOTE);
    expect(unmask(masked, hydrate(vault.entries())).text).toBe(NOTE);
  });
});

describe("unmaskDeep", () => {
  it("restores strings inside a nested tool-call payload without mutating it", () => {
    const { vault } = mask(NOTE);
    const input = {
      claimant: { name: "{{PERSON_1}}", contact: ["{{PHONE_1}}", { email: "{{EMAIL_1}}" }] },
      note: "Called {{PERSON_1}} re SSN {{SSN_1}}",
      priority: 2,
      urgent: true,
      tags: null,
    } satisfies JsonValue;
    const snapshot = structuredClone(input);

    const r = unmaskDeep(input, vault);

    expect(r.value).toEqual({
      claimant: { name: "Maria Gonzalez", contact: ["(512) 555-0198", { email: "maria@example.com" }] },
      note: "Called Maria Gonzalez re SSN 123-45-6789",
      priority: 2,
      urgent: true,
      tags: null,
    });
    expect(r.restored).toBe(5);
    expect(input).toEqual(snapshot);
  });

  it("reports warnings with a JSON pointer path", () => {
    const vault = new InMemoryVault();
    vault.set("Maria Gonzalez", "PERSON");
    const r = unmaskDeep({ to: [{ "na/me": "{{person_1}}" }] }, vault);
    expect(r.warnings).toEqual([
      { kind: "near-match", found: "{{person_1}}", suggestion: "{{PERSON_1}}", index: 0, path: "/to/0/na~1me" },
    ]);
  });
});
