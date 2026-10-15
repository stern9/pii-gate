import { describe, expect, it } from "vitest";
import { InMemoryVault, MemoryAuditLogger, mask, unmask, wrapAnthropic } from "../src/index.js";
import { FakeAnthropic, textMessage, textOf } from "./fake-client.js";

describe("adversarial inputs", () => {
  it("masks a name split across a line break and restores it verbatim", () => {
    const text = "Claimant: Maria\nGonzalez reported the loss. Maria Gonzalez later called back.";
    const { masked, vault } = mask(text);
    expect(masked).toBe("Claimant: {{PERSON_1}} reported the loss. {{PERSON_1}} later called back.");
    expect(masked).not.toMatch(/Maria|Gonzalez/);
    // Both occurrences share one token, so the restored spelling is the first one seen.
    expect(unmask("{{PERSON_1}}", vault).text).toBe("Maria\nGonzalez");
  });

  it("masks a name split across CRLF", () => {
    expect(mask("Insured: Tomasz\r\nKowalski, DOB pending").masked).toBe("Insured: {{PERSON_1}}, DOB pending");
  });

  it.each([
    ["missing opening brace", "{SSN_1}}"],
    ["missing closing brace", "{{SSN_1}"],
    ["lowercased", "{{ssn_1}}"],
    ["single braces", "{SSN_1}"],
    ["square brackets", "[[SSN_1]]"],
    ["space instead of underscore", "{{SSN 1}}"],
    ["braces dropped entirely", "SSN_1"],
  ])("does not restore a mangled token (%s) and emits a warning", (_label, mangled) => {
    const vault = new InMemoryVault();
    vault.set("123-45-6789", "SSN");
    const output = `Verified ${mangled} against the file.`;
    const r = unmask(output, vault);
    expect(r.text).toBe(output);
    expect(r.text).not.toContain("123-45-6789");
    expect(r.restored).toBe(0);
    expect(r.warnings).toEqual([
      { kind: "near-match", found: mangled, suggestion: "{{SSN_1}}", index: "Verified ".length },
    ]);
  });

  it("restores exact tokens next to a mangled one", () => {
    const vault = new InMemoryVault();
    vault.set("Maria Gonzalez", "PERSON");
    vault.set("123-45-6789", "SSN");
    const r = unmask("{{PERSON_1}} / {SSN_1}}", vault);
    expect(r.text).toBe("Maria Gonzalez / {SSN_1}}");
    expect(r.warnings.map((w) => w.kind)).toEqual(["near-match"]);
  });

  it("ignores token-like text for categories/numbers not in the vault", () => {
    const vault = new InMemoryVault();
    vault.set("123-45-6789", "SSN");
    expect(unmask("Form W_2 and {SSN_7}} and TX_1}", vault).warnings).toEqual([]);
  });

  it("masks PII inside a tool_result on the way in", async () => {
    const client = new FakeAnthropic(() => textMessage("Looked up {{PERSON_1}}."));
    const gated = wrapAnthropic(client);
    const crmResult = JSON.stringify({ name: "Mr. Kevin Osei", ssn: "SSN 456-78-9012", phone: "(214) 555-0133" });

    const res = await gated.messages.create({
      model: "claude-test",
      messages: [
        { role: "user", content: "Look up the client on claim 77." },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "crm_lookup", input: { claim: "77" } }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: crmResult },
            { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "Alt phone 469.555.0142" }] },
          ],
        },
      ],
    });

    const seen = client.seen();
    for (const raw of ["Kevin Osei", "456-78-9012", "(214) 555-0133", "469.555.0142"]) expect(seen).not.toContain(raw);
    expect(seen).toContain("{{PERSON_1}}");
    expect(seen).toContain("{{SSN_1}}");
    expect(textOf(res)).toBe("Looked up Kevin Osei.");
  });

  it("refuses to forward content it cannot inspect", async () => {
    const audit = new MemoryAuditLogger();
    const client = new FakeAnthropic(() => textMessage("ok"));
    const gated = wrapAnthropic(client, { audit });
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } };
    await expect(
      gated.messages.create({ model: "m", messages: [{ role: "user", content: [image] }] }),
    ).rejects.toThrow(/cannot inspect/);
    expect(client.calls).toHaveLength(0);
  });

  it("refuses streaming requests", async () => {
    const client = new FakeAnthropic(() => textMessage("ok"));
    const gated = wrapAnthropic(client);
    await expect(
      gated.messages.create({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/streaming/);
    expect(client.calls).toHaveLength(0);
  });

  it("does not unmask a token the model invents for a value it never saw", async () => {
    const client = new FakeAnthropic(() => textMessage("Your SSN is {{SSN_2}}"));
    const r = await wrapAnthropic(client).messages.createWithReport({
      model: "m",
      messages: [{ role: "user", content: "SSN 123-45-6789" }],
    });
    expect(textOf(r.message)).toBe("Your SSN is {{SSN_2}}");
    expect(r.report.warnings).toMatchObject([{ kind: "unknown-token", found: "{{SSN_2}}" }]);
  });
});
