import type Anthropic from "@anthropic-ai/sdk";
import {
  BUILT_IN_CATEGORIES,
  PiiBlockedError,
  wrapAnthropic,
  type AuditRecord,
  type BuiltInCategory,
  type CreateParamsLike,
  type MessageLike,
  type Policy,
  type PolicyAction,
  type UnmaskWarning,
} from "pii-gate/core";
import { SAMPLES, type Sample, type SampleShape } from "./samples";

/*
 * One run of the demo: note -> wrapAnthropic -> model -> restored reply.
 * Imports only the browser-safe core, so simulated runs execute entirely in
 * the visitor's browser and live runs use the exact same code on the server.
 */

export interface Block {
  type: string;
  [key: string]: unknown;
}

export interface DemoParams extends CreateParamsLike {
  model: string;
  max_tokens: number;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
}

export interface DemoMessage extends MessageLike {
  model: string;
  content: Block[];
  stop_reason?: string | null;
}

export type CreateFn = (params: DemoParams) => Promise<DemoMessage>;

export const ACTIONS: readonly PolicyAction[] = ["mask", "block", "allow"];
export const CATEGORIES: readonly BuiltInCategory[] = BUILT_IN_CATEGORIES;

export const SYSTEM_PROMPT = `You help insurance claims adjusters triage incoming notes.
Personal details in the note have been replaced with placeholders such as {{PERSON_1}} or {{PHONE_1}}. Use a placeholder exactly as written whenever you refer to that detail, and never guess what it stands for.
Call create_follow_up_task once. Put a summary of two or three sentences for the adjuster in its summary field.`;

export const FOLLOW_UP_TOOL: Anthropic.Beta.BetaTool = {
  name: "create_follow_up_task",
  description: "Create a follow-up task in the claims system for the adjuster handling this note.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Two or three sentences for the adjuster about what the note says." },
      subject: { type: "string", description: "One line: what to do and with whom." },
      contact: { type: "string", description: "How to reach the person, if the note gives a way." },
      due_in_days: { type: "integer", description: "Business days until the task is due." },
    },
    required: ["summary", "subject", "contact", "due_in_days"],
    additionalProperties: false,
  },
  strict: true,
};

export const LOOKUP_TOOL: Anthropic.Beta.BetaTool = {
  name: "lookup_customer",
  description: "Fetch a customer's record from the CRM by customer id.",
  input_schema: {
    type: "object",
    properties: { customer_id: { type: "string", description: "CRM customer id, e.g. CUST-10001." } },
    required: ["customer_id"],
    additionalProperties: false,
  },
  strict: true,
};

const TOOL_USE_ID = "toolu_demo_lookup_1";

/** A sample's text, sent as one user message ("note") or replayed as an agent loop that already called a tool. */
export function buildParams(note: string, model: string, sample?: Sample): DemoParams {
  const base = { model, max_tokens: 4000, system: SYSTEM_PROMPT };
  const call = sample?.shape === "tool_result" ? sample.toolCall : undefined;
  if (!call) return { ...base, messages: [{ role: "user", content: `Triage this note:\n\n${note}` }], tools: [FOLLOW_UP_TOOL] };
  // user asks -> assistant calls the tool -> user returns the record. wrapAnthropic masks all three turns.
  return {
    ...base,
    messages: [
      { role: "user", content: call.ask },
      { role: "assistant", content: [{ type: "tool_use", id: TOOL_USE_ID, name: call.name, input: call.input }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: TOOL_USE_ID, content: note }] },
    ],
    tools: [LOOKUP_TOOL, FOLLOW_UP_TOOL],
  };
}

/** What crossed the boundary, flattened for display. */
function sentView(params: DemoParams | undefined): Extract<GateRun, { ok: true }>["sent"] {
  const view: Extract<GateRun, { ok: true }>["sent"] = { system: params?.system ?? "", user: "" };
  for (const m of params?.messages ?? []) {
    if (typeof m.content === "string") {
      if (m.role === "user" && !view.user) view.user = m.content;
      continue;
    }
    for (const b of m.content) {
      if (b.type === "tool_use") view.toolUse = { name: b.name, input: b.input };
      if (b.type === "tool_result") {
        view.shape = "tool_result";
        view.toolResult =
          typeof b.content === "string" ? b.content : (b.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
      }
    }
  }
  return view;
}

export interface RunOptions {
  /**
   * The built-in sample this text came from. Defaults to the sample whose text
   * matches exactly, so an edited sample is sent as a plain note.
   */
  sampleId?: string;
}

export type GateRun =
  | {
      ok: true;
      /** Exactly what crossed the boundary to the model. */
      sent: {
        system: string;
        /** The user's own message (the note, or the request that started the agent loop). */
        user: string;
        /** "tool_result" when the note was replayed as a tool result; absent for a plain note. */
        shape?: SampleShape;
        /** The earlier tool call in the history, inputs masked. */
        toolUse?: { name: string; input: unknown };
        /** The masked tool_result content (the CRM record as the model saw it). */
        toolResult?: string;
      };
      /** The model's reply before restoration (placeholders intact). */
      raw: Block[];
      restored: Block[];
      /**
       * Each placeholder and the value it was swapped back for, so the page can
       * chip them. Fictional sample values already visible in `restored`.
       */
      restoredValues: { token: string; category: string; value: string }[];
      warnings: UnmaskWarning[];
      audit: AuditRecord;
      stopReason: string | null;
    }
  | {
      ok: false;
      /**
       * Error class name, the categories for a block, and whether the model
       * call itself failed (the SDK's message is never passed on). Never values.
       */
      error: { name: string; blockedCategories?: string[]; upstream?: boolean };
      audit?: AuditRecord;
    };

/** Only the blocks a reader cares about: non-empty text and tool calls (drops thinking blocks). */
function visible(blocks: readonly Block[]): Block[] {
  return blocks.filter((b) => b.type === "tool_use" || (b.type === "text" && typeof b.text === "string" && b.text.trim() !== ""));
}

/** Never hand the page an empty reply: say why there is nothing (no values in it, only the stop reason). */
function orNotice(blocks: Block[], stopReason: string | null): Block[] {
  if (blocks.length > 0) return blocks;
  return [{ type: "text", text: `(The model returned no text or tool call. Stop reason: ${stopReason ?? "none"}.)` }];
}

export async function runGate(
  note: string,
  policy: Policy,
  model: string,
  create: CreateFn,
  options: RunOptions = {},
): Promise<GateRun> {
  const sample = options.sampleId !== undefined ? SAMPLES.find((s) => s.id === options.sampleId) : SAMPLES.find((s) => s.text === note);
  const records: AuditRecord[] = [];
  let sent: DemoParams | undefined;
  let raw: DemoMessage | undefined;
  let upstreamFailed = false;
  const spy = {
    messages: {
      async create(params: DemoParams): Promise<DemoMessage> {
        sent = params;
        try {
          raw = await create(params);
        } catch (err) {
          upstreamFailed = true;
          throw err;
        }
        return raw;
      },
    },
  };
  const gate = wrapAnthropic<DemoParams, DemoMessage>(spy, { policy, audit: { write: (r) => void records.push(r) } });

  try {
    const { message, report } = await gate.messages.createWithReport(buildParams(note, model, sample));
    const stopReason = message.stop_reason ?? null;
    return {
      ok: true,
      sent: sentView(sent),
      raw: orNotice(visible(raw?.content ?? []), stopReason),
      restored: orNotice(visible(message.content), stopReason),
      restoredValues: report.vault.entries().map(({ token, category, value }) => ({ token, category, value })),
      warnings: report.warnings,
      audit: records[0] as AuditRecord,
      stopReason,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    return {
      ok: false,
      error: { name, blockedCategories: err instanceof PiiBlockedError ? err.categories : undefined, upstream: upstreamFailed },
      audit: records[0],
    };
  }
}

/** Validates a policy coming from the browser: known categories and actions only. */
export function parsePolicy(value: unknown): Policy | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const policy: Policy = {};
  for (const [category, action] of Object.entries(value)) {
    if (!CATEGORIES.includes(category as BuiltInCategory)) return undefined;
    if (!ACTIONS.includes(action as PolicyAction)) return undefined;
    policy[category] = action as PolicyAction;
  }
  return policy;
}
