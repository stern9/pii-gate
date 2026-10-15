/**
 * mask -> (fake) model call -> unmask, end to end, with no network.
 * Run: npm run example
 */
import {
  MemoryAuditLogger,
  PiiBlockedError,
  mask,
  unmask,
  wrapAnthropic,
  type CreateParamsLike,
  type MessageLike,
} from "../src/index.js";

const claimNote = `Claim # CLM-88412 — Insured: Maria Gonzalez, DOB: 03/14/1979.
Called from (512) 555-0198 about the rear-end collision. VIN 1HGCM82633A004352.
Maria Gonzalez asked that the adjuster email maria.gonzalez@example.com.`;

function section(title: string): void {
  console.log(`\n=== ${title} ${"=".repeat(Math.max(0, 60 - title.length))}`);
}

// 1. Low-level API ----------------------------------------------------------
section("1. mask()");
const { masked, vault, findings } = mask(claimNote, {
  schemaHints: { claimNumber: { value: "CLM-88412", category: "CLAIM_ID" } },
});
console.log(masked);
console.log("\nfindings:", findings.map((f) => `${f.category}${f.token ? ` -> ${f.token}` : ""}`).join(", "));

section("2. what a model might reply");
const modelReply = `Draft email to {{EMAIL_1}}:
Hi {{PERSON_1}}, we received your report for claim {{CLAIM_ID_1}} regarding vehicle {{VIN_1}}.
We'll call you at {{PHONE_1}} within one business day. (Ref: {person_1}})`;
console.log(modelReply);

section("3. unmask()");
const restored = unmask(modelReply, vault);
console.log(restored.text);
console.log("\nwarnings:", restored.warnings);

// 2. Wrapped client ---------------------------------------------------------
type Block = { type: string; [key: string]: unknown };
interface Params extends CreateParamsLike {
  model: string;
  messages: { role: string; content: string | Block[] }[];
}
interface Message extends MessageLike {
  model: string;
  content: Block[];
}

/** Stands in for `new Anthropic()`; prints exactly what would go over the wire. */
const fakeClient = {
  messages: {
    async create(params: Params): Promise<Message> {
      console.log("[model received]", JSON.stringify(params.messages[0]?.content));
      return {
        model: params.model,
        content: [
          { type: "text", text: "I'll open a follow-up task for {{PERSON_1}}." },
          { type: "tool_use", id: "tu_1", name: "create_task", input: { assignee: "adjuster", about: "{{PERSON_1}}", phone: "{{PHONE_1}}" } },
        ],
      };
    },
  },
};

async function wrapped(): Promise<void> {
  section("4. wrapAnthropic()");
  const audit = new MemoryAuditLogger();
  const client = wrapAnthropic(fakeClient, { audit, policy: { SSN: "block" } });

  const message = await client.messages.create({
    model: "claude-opus-5-5",
    messages: [{ role: "user", content: `Summarize and create a follow-up task:\n${claimNote}` }],
  });
  console.log("[app received]", JSON.stringify(message.content, null, 2));
  console.log("[audit]", JSON.stringify(audit.records[0]));

  section("5. policy: block");
  try {
    await client.messages.create({ model: "claude-opus-5-5", messages: [{ role: "user", content: "SSN 123-45-6789" }] });
  } catch (err) {
    if (!(err instanceof PiiBlockedError)) throw err;
    console.log(`${err.name}: ${err.message}`);
    console.log("[audit]", JSON.stringify(audit.records[1]));
  }
}

await wrapped();
