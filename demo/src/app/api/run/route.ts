import { parsePolicy, runGate } from "@/lib/gate";
import { LIVE_MODEL, liveAvailable, liveModel } from "@/lib/live-model";
import { findSample } from "@/lib/samples";

/*
 * Live mode only. The browser sends a sample id and a policy, never text:
 * the note is looked up here, so only the built-in fictional samples can
 * reach this server or the model. Request and response bodies are not logged.
 */

const WINDOW_MS = 60_000;
const PER_IP_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

/** Best effort: per server instance, which is enough to stop casual abuse of a demo. */
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > PER_IP_PER_WINDOW;
}

function fail(status: number, message: string): Response {
  return Response.json({ message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  if (!liveAvailable()) return fail(503, "Live mode is not configured on this deployment.");
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(ip)) return fail(429, "Too many live runs. Try again in a minute, or use the simulated model.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Expected a JSON body.");
  }
  const { sampleId, policy: rawPolicy } = (body ?? {}) as { sampleId?: unknown; policy?: unknown };
  const sample = typeof sampleId === "string" ? findSample(sampleId) : undefined;
  if (!sample) return fail(400, "Live mode runs only on the built-in samples.");
  const policy = parsePolicy(rawPolicy ?? {});
  if (!policy) return fail(400, "Invalid policy.");

  const run = await runGate(sample.text, policy, LIVE_MODEL, liveModel, { sampleId: sample.id });
  return Response.json(run);
}
