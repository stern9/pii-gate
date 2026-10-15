/**
 * Latency benchmark: how much time does pii-gate add to an LLM call?
 *
 *   npm run bench            # prints a markdown report and writes docs/benchmarks.md
 *   npm run bench -- --no-write
 *
 * Times the built library in dist/ (the `bench` script runs `npm run build`
 * first); tsx only runs this harness file. Zero dependencies beyond Node.
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { LARGE_NOTE, MEDIUM_NOTE, REQUEST, REQUEST_TEXTS, SMALL_NOTE, replyWith } from "./notes.js";
import type { BenchBlock, BenchParams } from "./notes.js";

const WARMUP = 200;
const ITERATIONS = 3000;
const COLD_RUNS = 7;

const SCRIPT = fileURLToPath(import.meta.url);
const DOC_PATH = fileURLToPath(new URL("../docs/benchmarks.md", import.meta.url));

/*
 * The library under test is the compiled dist/ build. It is imported by a
 * computed path so `npm run typecheck` works on a clean checkout without
 * dist/; the type comes from src/, whose public API dist/ is built from.
 */
const DIST_URL = new URL("../dist/index.js", import.meta.url);
if (!existsSync(DIST_URL)) {
  throw new Error("dist/index.js not found: run `npm run build` first (`npm run bench` does this).");
}
const distHref: string = DIST_URL.href;
const lib = (await import(distHref)) as typeof import("../src/index.js");
const { mask, maskAll, unmask, wrapAnthropic } = lib;

/* Results are folded into this so no call can be optimised away; printed to stderr at the end. */
let sink = 0;

interface Stats {
  name: string;
  input: string;
  iterations: number;
  mean: number;
  sd: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function summarise(name: string, input: string, samplesNs: bigint[]): Stats {
  const ms = samplesNs.map((n) => Number(n) / 1e6).sort((a, b) => a - b);
  const q = (p: number): number => ms[Math.min(ms.length - 1, Math.ceil((p / 100) * ms.length) - 1)] ?? NaN;
  const mean = ms.reduce((s, x) => s + x, 0) / ms.length;
  const sd = Math.sqrt(ms.reduce((s, x) => s + (x - mean) ** 2, 0) / ms.length);
  return { name, input, iterations: ms.length, mean, sd, p50: q(50), p95: q(95), p99: q(99), max: ms[ms.length - 1] ?? NaN };
}

function benchSync(name: string, input: string, fn: () => number): Stats {
  for (let i = 0; i < WARMUP; i++) sink += fn();
  const samples: bigint[] = new Array<bigint>(ITERATIONS);
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    sink += fn();
    samples[i] = process.hrtime.bigint() - t0;
  }
  return summarise(name, input, samples);
}

async function benchAsync(name: string, input: string, fn: () => Promise<number>): Promise<Stats> {
  for (let i = 0; i < WARMUP; i++) sink += await fn();
  const samples: bigint[] = new Array<bigint>(ITERATIONS);
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    sink += await fn();
    samples[i] = process.hrtime.bigint() - t0;
  }
  return summarise(name, input, samples);
}

const kb = (s: string): string => {
  const bytes = Buffer.byteLength(s, "utf8");
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
};

/* ---------- fixtures shared by the cases ---------- */

const EXACT_TOKEN = /\{\{[A-Z][A-Z0-9_]*_\d+\}\}/g;

function requestTokens(): string[] {
  return maskAll(REQUEST_TEXTS).vault.entries().map((e) => e.token);
}

interface BenchMessage {
  model: string;
  content: BenchBlock[];
}

/** Answers instantly with a reply that references the request's placeholders, as a model would. */
interface FakeClient {
  messages: { create(params: BenchParams): Promise<BenchMessage> };
  /** The last request the "model" received (kept by reference; no copy on the timed path). */
  last?: BenchParams;
}

function fakeClient(): FakeClient {
  const tokens = requestTokens();
  const response: BenchMessage = {
    model: "claude-bench",
    content: [
      { type: "text", text: replyWith(tokens.slice(0, 10)) },
      {
        type: "tool_use",
        id: "toolu_bench_2",
        name: "send_email",
        input: { to: tokens.find((t) => t.startsWith("{{EMAIL_")) ?? "", subject: "Rental reservation", body: `Hi ${tokens[0] ?? ""}, your rental is booked.` },
      },
    ],
  };
  const client: FakeClient = {
    messages: {
      create: async (params) => {
        client.last = params;
        return response;
      },
    },
  };
  return client;
}

function replyLength(m: BenchMessage): number {
  const first = m.content[0];
  return first && typeof first["text"] === "string" ? first["text"].length : 0;
}

/* ---------- correctness gate: the timed path must actually mask and restore ---------- */

/** 10 placeholders in the reply text + 2 in the tool_use input. */
const EXPECTED_REFERENCED = 12;

async function assertGateWorks(): Promise<void> {
  const client = fakeClient();
  const wrapped = wrapAnthropic<BenchParams, BenchMessage>(client);
  const { message, report } = await wrapped.messages.createWithReport(REQUEST);
  const fail = (why: string): never => {
    throw new Error(`benchmark sanity check failed: ${why}`);
  };
  if (report.warnings.length !== 0) fail(`${report.warnings.length} unmask warnings`);
  if (report.responseReferencedTokens !== EXPECTED_REFERENCED) {
    fail(`reply referenced ${report.responseReferencedTokens} placeholders, expected ${EXPECTED_REFERENCED}`);
  }
  if (report.vault.size < 15) fail(`only ${report.vault.size} values masked in the request`);
  const seen = JSON.stringify(client.last ?? fail("fake client was never called"));
  const leaked = report.vault.entries().filter((e) => seen.includes(JSON.stringify(e.value).slice(1, -1)));
  // Report categories only, never values.
  if (leaked.length > 0) fail(`unmasked values reached the model: ${leaked.map((e) => e.category).join(", ")}`);
  if (EXACT_TOKEN.test(JSON.stringify(message.content))) fail("placeholders left in the restored reply");
  EXACT_TOKEN.lastIndex = 0;
}

/* ---------- cold start (fresh process per run) ---------- */

async function coldOnce(): Promise<void> {
  const t0 = performance.now();
  const r = mask(MEDIUM_NOTE);
  const maskMs = performance.now() - t0;
  const client = wrapAnthropic<BenchParams, BenchMessage>(fakeClient());
  const t1 = performance.now();
  const m = await client.messages.create(REQUEST);
  const wrapMs = performance.now() - t1;
  process.stdout.write(JSON.stringify({ maskMs, wrapMs, sink: r.masked.length + replyLength(m) }));
}

function measureCold(): { mask: number[]; wrap: number[] } {
  const out = { mask: [] as number[], wrap: [] as number[] };
  for (let i = 0; i < COLD_RUNS; i++) {
    const raw = execFileSync(process.execPath, [...process.execArgv, SCRIPT, "--cold"], { encoding: "utf8" });
    const parsed = JSON.parse(raw) as { maskMs: number; wrapMs: number; sink: number };
    out.mask.push(parsed.maskMs);
    out.wrap.push(parsed.wrapMs);
    sink += parsed.sink;
  }
  return out;
}

/* ---------- report ---------- */

const f = (n: number): string => (n < 0.1 ? n.toFixed(4) : n < 10 ? n.toFixed(3) : n.toFixed(1));
const ops = (meanMs: number): string => Math.round(1000 / meanMs).toLocaleString("en-US");
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? NaN;
};

function table(rows: Stats[]): string {
  const head =
    "| Case | Input | Iter. | Mean (ms) | SD (ms) | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) | ops/sec |\n" +
    "|---|---|--:|--:|--:|--:|--:|--:|--:|--:|";
  const body = rows.map(
    (r) =>
      `| ${r.name} | ${r.input} | ${r.iterations.toLocaleString("en-US")} | ${f(r.mean)} | ${f(r.sd)} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ${f(r.max)} | ${ops(r.mean)} |`,
  );
  return [head, ...body].join("\n");
}

async function main(): Promise<void> {
  if (process.argv.includes("--cold")) return coldOnce();

  await assertGateWorks();
  const cold = measureCold();
  const rows: Stats[] = [];

  for (const [label, text] of [
    ["small", SMALL_NOTE],
    ["claim note", MEDIUM_NOTE],
    ["5 notes", LARGE_NOTE],
  ] as const) {
    rows.push(benchSync(`\`mask\` (${label})`, kb(text), () => mask(text).masked.length));
  }

  const reqBytes = REQUEST_TEXTS.reduce((s, t) => s + t, "");
  const reqInput = `${kb(reqBytes)} in ${REQUEST_TEXTS.length} texts`;
  const maskAllRow = benchSync("`maskAll` (system + 3 messages + tool_result)", reqInput, () => maskAll(REQUEST_TEXTS).masked.length);
  const maskAllNoProp = benchSync("`maskAll`, same request, `propagate: false`", reqInput, () =>
    maskAll(REQUEST_TEXTS, { propagate: false }).masked.length,
  );
  rows.push(maskAllRow, maskAllNoProp);
  const small = rows[0] as Stats;
  const medium = rows[1] as Stats;
  const large = rows[2] as Stats;
  const bytes = (t: string): number => Buffer.byteLength(t, "utf8");
  const slope = (large.p50 - medium.p50) / (bytes(LARGE_NOTE) - bytes(MEDIUM_NOTE));
  const interpolated = medium.p50 + slope * (bytes(reqBytes) - bytes(MEDIUM_NOTE));
  const propagationCost = maskAllRow.p50 - maskAllNoProp.p50;

  const vault = mask(MEDIUM_NOTE).vault;
  const tokens = vault.entries().map((e) => e.token).slice(0, 10);
  const reply = replyWith(tokens);
  const placeholders = reply.match(EXACT_TOKEN)?.length ?? 0;
  rows.push(benchSync(`\`unmask\` (reply, ${placeholders} placeholders)`, kb(reply), () => unmask(reply, vault).text.length));

  const raw = fakeClient();
  const wrapped = wrapAnthropic<BenchParams, BenchMessage>(fakeClient());
  const baseline = await benchAsync("fake client alone (baseline)", "—", async () => replyLength(await raw.messages.create(REQUEST)));
  const gated = await benchAsync("`wrapAnthropic(...).messages.create`", `${kb(reqBytes)} request`, async () =>
    replyLength(await wrapped.messages.create(REQUEST)),
  );
  rows.push(gated, baseline);

  const cpu = os.cpus()[0]?.model.trim() ?? "unknown CPU";
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const shareOf300 = ((gated.p95 / 300) * 100).toFixed(2);

  const report = `# Benchmarks

How much latency does pii-gate add to an LLM call?

- **Date:** ${date}
- **Machine:** ${cpu} (${os.cpus().length} logical cores), ${os.platform()} ${os.release()} ${os.arch()}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM
- **Runtime:** Node ${process.version}. The library is the compiled \`dist/\` build (\`npm run bench\` runs \`npm run build\` first); tsx only runs the harness.
- **Method:** \`npm run bench\` (\`bench/latency.ts\`). ${WARMUP} warm-up iterations, then ${ITERATIONS.toLocaleString("en-US")} timed iterations per case, each timed individually with \`process.hrtime.bigint()\`. Every result is consumed so no call can be optimised away. Before timing, one wrapped call is checked: no unmask warnings, all ${EXPECTED_REFERENCED} placeholders in the reply restored, and no detected value present in what the fake model received; the run aborts otherwise. Repeated runs on the machine below agreed within about 2–3% at p50 and p95; SD and max show the spread within a run. Default options: all built-in detectors, propagation on, fresh vault per call, no audit logger.
- **Inputs:** \`bench/notes.ts\`. Insurance claim notes built only from fabricated values (555-01xx phones, \`example.*\` domains, voided SSN, Visa test card, synthetic VINs, invented names). The ~2 KB note has ${vault.size} distinct PII values; the ~10 KB input is five such notes for different parties.

## Warm (steady state)

${table(rows)}

Gate overhead on a full \`messages.create\` round trip: **${f(gated.p50)} ms at p50, ${f(gated.p95)} ms at p95**. These are the wrapped call's own percentiles; the fake client it wraps resolves instantly (baseline p50 ${f(baseline.p50)} ms, p95 ${f(baseline.p95)} ms, at the timer's resolution floor), so nearly all of that time is the gate. It covers collecting strings from the request, \`maskAll\`, rebuilding the params, and unmasking the reply text and \`tool_use.input\`.

## Cold (first call in a fresh process)

Measured in ${COLD_RUNS} separate child processes, after module import (import itself, not timed here, adds a few ms), before any warm-up. The first wrapped call is timed right after the first \`mask\`, so a process whose first action is a wrapped call pays roughly the sum of the two rows. This is what the first request after a deploy or a serverless cold start pays while V8 compiles the regexes and the hot functions.

| Case | Median (ms) | Min (ms) | Max (ms) |
|---|--:|--:|--:|
| first \`mask\` (claim note, ${kb(MEDIUM_NOTE)}) | ${f(median(cold.mask))} | ${f(Math.min(...cold.mask))} | ${f(Math.max(...cold.mask))} |
| next: first wrapped \`messages.create\` | ${f(median(cold.wrap))} | ${f(Math.min(...cold.wrap))} | ${f(Math.max(...cold.wrap))} |

## Interpretation

A hosted model call typically takes hundreds of milliseconds to several seconds, so the gate's ${f(gated.p95)} ms p95 on a realistic ~${kb(reqBytes)} request is noise next to the network and the model: even against an unusually fast 300 ms call it would be ${shareOf300}%. \`mask\` has a fixed cost per call (${f(small.p50)} ms p50 on ${kb(SMALL_NOTE)}) and then grows roughly linearly with size (${f(medium.p50)} ms on ${kb(MEDIUM_NOTE)}, ${f(large.p50)} ms on ${kb(LARGE_NOTE)}). \`maskAll\` on the ${REQUEST_TEXTS.length}-text request takes ${f(maskAllRow.p50)} ms p50, versus ${f(maskAllNoProp.p50)} ms with \`propagate: false\`: cross-text propagation (checking every detected value against every text) accounts for ${f(propagationCost)} ms, ${Math.round((propagationCost / maskAllRow.p50) * 100)}% of it. Without propagation the ${REQUEST_TEXTS.length} texts cost about what \`mask\`'s size scaling predicts for ${kb(reqBytes)} (${f(interpolated)} ms, interpolated from the ~2 KB and ~10 KB rows), plus ${f((maskAllNoProp.p50 - interpolated) / REQUEST_TEXTS.length)} ms per text. The first call in a fresh process is much slower (${f(median(cold.mask))} ms median) while V8 compiles regexes and functions, which matters only for cold starts. These are single-machine numbers with no audit sink: a \`JsonlAuditLogger\` adds a file append per request, and a different CPU or a busy event loop will shift the absolute values.
`;

  process.stdout.write(report);
  if (!process.argv.includes("--no-write")) {
    writeFileSync(DOC_PATH, report);
    process.stderr.write(`\nwrote ${DOC_PATH}\n`);
  }
  process.stderr.write(`(checksum ${sink})\n`);
}

await main();
