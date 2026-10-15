import type { Block, CreateFn, DemoMessage, DemoParams } from "./gate";

const TOKEN = /\{\{([A-Z][A-Z0-9_]*)_(\d+)\}\}/g;

/** Every string the model would read: user text, tool inputs and tool results. */
function promptText(params: DemoParams): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
  };
  walk(params.messages);
  return out.join("\n");
}

/** First placeholder of each category in the masked prompt, e.g. { PERSON: "{{PERSON_1}}" }. */
function firstTokens(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(TOKEN)) out[m[1] as string] ??= m[0];
  return out;
}

type Scenario = "auto-claim" | "workers-comp" | "renewal-email" | "crm-tool-result" | "known-gaps";

/** Like the real model, recognise the situation from the (masked) content; sampleId just skips the guess. */
function scenario(params: DemoParams, text: string, sampleId?: string): Scenario | undefined {
  const known: Scenario[] = ["auto-claim", "workers-comp", "renewal-email", "crm-tool-result", "known-gaps"];
  if (sampleId && (known as string[]).includes(sampleId)) return sampleId as Scenario;
  if (params.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"))) return "crm-tool-result";
  if (/rear-end collision/i.test(text)) return "auto-claim";
  if (/workers' comp/i.test(text)) return "workers-comp";
  if (/renewal/i.test(text) && /card/i.test(text)) return "renewal-email";
  if (/hail damage/i.test(text)) return "known-gaps";
  return undefined;
}

interface Reply {
  summary: string;
  subject: string;
  contact: string;
}

/**
 * Two or three sentences an adjuster would write, using placeholders where the
 * prompt has them and a neutral word where a category was sent in clear text.
 */
function compose(s: Scenario | undefined, t: Record<string, string>): Reply {
  const who = t.PERSON ?? "the insured";
  const Who = t.PERSON ?? "The insured";
  const phone = t.PHONE;
  const email = t.EMAIL;
  const reach = phone && email ? `${phone} or ${email}` : (phone ?? email);
  const contact = reach ?? "not given";
  switch (s) {
    case "auto-claim":
      return {
        summary:
          `${Who} reported a rear-end collision on I-35; the other driver left the scene. ` +
          `Confirm the loss details with ${who}${phone ? ` at ${phone}` : ""} and check the vehicle record for ${t.VIN ?? "the Accord"}` +
          `${t.DRIVERS_LICENSE ? ` and license ${t.DRIVERS_LICENSE}` : ""}. ` +
          (email ? `${Who} asked for updates at ${email}.` : `${Who} asked for updates by email.`),
        subject: `Confirm hit-and-run loss details with ${who}`,
        contact,
      };
    case "workers-comp":
      return {
        summary:
          `${Who} strained their lower back lifting inventory, was seen at urgent care the same day and is off work for 5 days. ` +
          `Verify identity against ${t.SSN ?? "the SSN on file"} and ${t.DOB ?? "the date of birth"} before setting up wage benefits, ` +
          `and confirm the home address ${t.ADDRESS ?? "on file"}${phone ? ` by calling ${phone}` : ""}.`,
        subject: `Set up lost-time benefits for ${who}`,
        contact,
      };
    case "renewal-email":
      return {
        summary:
          `${Who} wants the HO-55120 renewal charged to ${t.CREDIT_CARD ?? "the card in the email"}, with the receipt sent to ${email ?? "their email address"}. ` +
          `Card details should not be taken over email: call ${who}${phone ? ` at ${phone}` : ""} after 5pm to collect payment through the secure line.`,
        subject: `Collect renewal payment from ${who} by phone`,
        contact,
      };
    case "crm-tool-result":
      return {
        summary:
          `${Who} (CUST-48201) has account 4471-2290 in good standing. ` +
          `${Who} prefers email, so send updates to ${email ?? "the address on file"}${phone ? ` and use ${phone} only if email bounces` : ""}. ` +
          `Date of birth on file is ${t.DOB ?? "recorded"} if identity needs checking.`,
        subject: `Email ${who} about the account review`,
        contact: email ?? contact,
      };
    case "known-gaps":
      return {
        summary:
          // The note's uncued name and 7-digit number reached the model in clear text, so they appear here as-is.
          `jordan ellery reported hail damage and says the roofer will call back from 555-0139 tomorrow; ${who} confirmed the same. ` +
          `Follow up with ${who} once the roofer's estimate is in.`,
        subject: `Get the roofer's hail estimate for ${who}`,
        contact,
      };
    default:
      return {
        summary:
          `${Who} is the subject of this note${reach ? ` and can be reached at ${reach}` : ""}. ` +
          `Confirm the details in the note with ${who} before taking action.`,
        subject: `Confirm details with ${who}`,
        contact,
      };
  }
}

/** Damage the last placeholder (a person's if there is one) the way a model sometimes does: "{{PERSON_1}}" -> "{person_1}}". */
function mangleLast(summary: string, t: Record<string, string>): string {
  const target = t.PERSON && summary.includes(t.PERSON) ? t.PERSON : [...summary.matchAll(TOKEN)].at(-1)?.[0];
  if (!target) return summary;
  const i = summary.lastIndexOf(target);
  return summary.slice(0, i) + target.slice(1).toLowerCase() + summary.slice(i + target.length);
}

/**
 * A stand-in for Claude that runs in the browser. It sees only the masked
 * prompt, like the real model, and writes a reply that uses the placeholders.
 * With `mangle`, it damages one placeholder the way a model sometimes does,
 * to show that pii-gate warns instead of guessing.
 */
export function simulatedModel({ mangle, sampleId }: { mangle: boolean; sampleId?: string }): CreateFn {
  return async (params) => {
    const text = promptText(params);
    const t = firstTokens(text);
    const reply = compose(scenario(params, text, sampleId), t);
    const summary = mangle ? mangleLast(reply.summary, t) : reply.summary;

    // Same shape as the live model: the summary travels inside the tool call.
    const content: Block[] = [
      {
        type: "tool_use",
        id: "toolu_simulated_1",
        name: "create_follow_up_task",
        input: { summary, subject: reply.subject, contact: reply.contact, due_in_days: 2 },
      },
    ];
    const message: DemoMessage = { model: "simulated", content, stop_reason: "tool_use" };
    return message;
  };
}
