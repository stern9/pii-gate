import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { CreateFn, DemoMessage } from "./gate";

/** Override with DEMO_MODEL (e.g. claude-haiku-5-5) to trade quality for cost. */
export const LIVE_MODEL = process.env.DEMO_MODEL ?? "claude-opus-5-5";

export function liveAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let client: Anthropic | undefined;

/**
 * Calls Claude with the already-masked params. Server-side fallback routes a
 * refused request to another model inside the same call.
 */
export const liveModel: CreateFn = async (params) => {
  client ??= new Anthropic({ maxRetries: 1, timeout: 60_000 });
  const message = await client.beta.messages.create({
    ...params,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  // The SDK's content blocks are a superset of the demo's structural Block.
  return message as unknown as DemoMessage;
};
