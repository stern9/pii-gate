import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { CreateFn, DemoMessage } from "./gate";

/** Override with DEMO_MODEL. `||`, not `??`: an empty DEMO_MODEL= line means the default. */
export const LIVE_MODEL = process.env.DEMO_MODEL || "claude-sonnet-5-5";

/** Models that accept server-side refusal fallback (`fallbacks: "default"`). Haiku does not. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export function liveAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let client: Anthropic | undefined;

/**
 * Calls Claude with the already-masked params. On models that support it,
 * server-side fallback routes a refused request to another model in the same call.
 */
export const liveModel: CreateFn = async (params) => {
  client ??= new Anthropic({ maxRetries: 1, timeout: 60_000 });
  const fallback = FALLBACK_MODELS.has(params.model)
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};
  const message = await client.beta.messages.create({ ...params, output_config: { effort: "low" }, ...fallback });
  // The SDK's content blocks are a superset of the demo's structural Block.
  return message as unknown as DemoMessage;
};
