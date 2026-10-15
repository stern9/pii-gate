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
  messages: { role: "user"; content: string }[];
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

export function buildParams(note: string, model: string): DemoParams {
  return {
    model,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Triage this note:\n\n${note}` }],
    tools: [FOLLOW_UP_TOOL],
  };
}

export type GateRun =
  | {
      ok: true;
      /** Exactly what crossed the boundary to the model. */
      sent: { system: string; user: string };
      /** The model's reply before restoration (placeholders intact). */
      raw: Block[];
      restored: Block[];
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

/** Only the blocks a reader cares about: text and tool calls (drops empty thinking blocks). */
function visible(blocks: readonly Block[]): Block[] {
  return blocks.filter((b) => b.type === "text" || b.type === "tool_use");
}

export async function runGate(note: string, policy: Policy, model: string, create: CreateFn): Promise<GateRun> {
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
    const { message, report } = await gate.messages.createWithReport(buildParams(note, model));
    return {
      ok: true,
      sent: { system: sent?.system ?? "", user: sent?.messages[0]?.content ?? "" },
      raw: visible(raw?.content ?? []),
      restored: visible(message.content),
      warnings: report.warnings,
      audit: records[0] as AuditRecord,
      stopReason: message.stop_reason ?? null,
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
