import type { Block, CreateFn, DemoMessage } from "./gate";

const TOKEN = /\{\{([A-Z][A-Z0-9_]*)_(\d+)\}\}/g;

/** First placeholder of each category in the masked prompt, e.g. { PERSON: "{{PERSON_1}}" }. */
function firstTokens(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(TOKEN)) out[m[1] as string] ??= m[0];
  return out;
}

/**
 * A stand-in for Claude that runs in the browser. It sees only the masked
 * prompt, like the real model, and writes a reply that uses the placeholders.
 * With `mangle`, it damages one placeholder the way a model sometimes does,
 * to show that pii-gate warns instead of guessing.
 */
export function simulatedModel({ mangle }: { mangle: boolean }): CreateFn {
  return async (params) => {
    const prompt = params.messages.map((m) => m.content).join("\n");
    const t = firstTokens(prompt);
    const who = t.PERSON ?? "the customer";
    const contact = t.PHONE ?? t.EMAIL;
    const ids = ["VIN", "DOB", "SSN", "DRIVERS_LICENSE", "CREDIT_CARD", "ADDRESS"].flatMap((c) => (t[c] ? [t[c]] : []));

    const sentences = [
      `${who} is the subject of this note${contact ? ` and can be reached at ${contact}` : ""}.`,
      ids.length > 0 ? `Identifiers on file: ${ids.join(", ")}.` : "No other identifiers were masked.",
      `I'll open a follow-up task so the adjuster confirms the details with ${who}.`,
    ];
    let text = `[Simulated model] ${sentences.join(" ")}`;
    if (mangle && t.PERSON) {
      const i = text.lastIndexOf(t.PERSON);
      text = text.slice(0, i) + t.PERSON.slice(1).toLowerCase() + text.slice(i + t.PERSON.length);
    }

    const content: Block[] = [
      { type: "text", text },
      {
        type: "tool_use",
        id: "toolu_simulated_1",
        name: "create_follow_up_task",
        input: { subject: `Confirm loss details with ${who}`, contact: contact ?? "not given", due_in_days: 2 },
      },
    ];
    const message: DemoMessage = { model: "simulated", content, stop_reason: "tool_use" };
    return message;
  };
}
