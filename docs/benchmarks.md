# Benchmarks

How much latency does pii-gate add to an LLM call?

- **Date:** 2026-10-14
- **Machine:** Apple M5 Pro (18 logical cores), darwin 27.0.0 arm64, 48 GB RAM
- **Runtime:** Node v24.21.0. The library is the compiled `dist/` build (`npm run bench` runs `npm run build` first); tsx only runs the harness.
- **Method:** `npm run bench` (`bench/latency.ts`). 200 warm-up iterations, then 3,000 timed iterations per case, each timed individually with `process.hrtime.bigint()`. Every result is consumed so no call can be optimised away. Before timing, one wrapped call is checked: no unmask warnings, all 12 placeholders in the reply restored, and no detected value present in what the fake model received; the run aborts otherwise. Repeated runs on the machine below agreed within about 2–3% at p50 and p95; SD and max show the spread within a run. Default options: all built-in detectors, propagation on, fresh vault per call, no audit logger.
- **Inputs:** `bench/notes.ts`. Insurance claim notes built only from fabricated values (555-01xx phones, `example.*` domains, voided SSN, Visa test card, synthetic VINs, invented names). The ~2 KB note has 12 distinct PII values; the ~10 KB input is five such notes for different parties.

## Warm (steady state)

| Case | Input | Iter. | Mean (ms) | SD (ms) | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) | ops/sec |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|
| `mask` (small) | 279 B | 3,000 | 0.0380 | 0.0084 | 0.0360 | 0.0457 | 0.0813 | 0.158 | 26,289 |
| `mask` (claim note) | 1.9 KB | 3,000 | 0.0741 | 0.0107 | 0.0709 | 0.0865 | 0.122 | 0.236 | 13,490 |
| `mask` (5 notes) | 9.7 KB | 3,000 | 0.297 | 0.0343 | 0.287 | 0.353 | 0.439 | 0.948 | 3,371 |
| `maskAll` (system + 3 messages + tool_result) | 2.6 KB in 6 texts | 3,000 | 0.241 | 0.0181 | 0.234 | 0.282 | 0.308 | 0.408 | 4,150 |
| `maskAll`, same request, `propagate: false` | 2.6 KB in 6 texts | 3,000 | 0.131 | 0.0120 | 0.127 | 0.150 | 0.187 | 0.268 | 7,656 |
| `unmask` (reply, 10 placeholders) | 444 B | 3,000 | 0.0041 | 0.0033 | 0.0039 | 0.0047 | 0.0083 | 0.111 | 241,588 |
| `wrapAnthropic(...).messages.create` | 2.6 KB request | 3,000 | 0.258 | 0.0234 | 0.249 | 0.302 | 0.340 | 0.752 | 3,883 |
| fake client alone (baseline) | — | 3,000 | 0.0002 | 0.0013 | 0.0001 | 0.0002 | 0.0003 | 0.0698 | 6,379,897 |

Gate overhead on a full `messages.create` round trip: **0.249 ms at p50, 0.302 ms at p95**. These are the wrapped call's own percentiles; the fake client it wraps resolves instantly (baseline p50 0.0001 ms, p95 0.0002 ms, at the timer's resolution floor), so nearly all of that time is the gate. It covers collecting strings from the request, `maskAll`, rebuilding the params, and unmasking the reply text and `tool_use.input`.

## Cold (first call in a fresh process)

Measured in 7 separate child processes, after module import (import itself, not timed here, adds a few ms), before any warm-up. The first wrapped call is timed right after the first `mask`, so a process whose first action is a wrapped call pays roughly the sum of the two rows. This is what the first request after a deploy or a serverless cold start pays while V8 compiles the regexes and the hot functions.

| Case | Median (ms) | Min (ms) | Max (ms) |
|---|--:|--:|--:|
| first `mask` (claim note, 1.9 KB) | 14.6 | 14.3 | 14.8 |
| next: first wrapped `messages.create` | 2.389 | 1.988 | 2.489 |

## Interpretation

A hosted model call typically takes hundreds of milliseconds to several seconds, so the gate's 0.302 ms p95 on a realistic ~2.6 KB request is noise next to the network and the model: even against an unusually fast 300 ms call it would be 0.10%. `mask` has a fixed cost per call (0.0360 ms p50 on 279 B) and then grows roughly linearly with size (0.0709 ms on 1.9 KB, 0.287 ms on 9.7 KB). `maskAll` on the 6-text request takes 0.234 ms p50, versus 0.127 ms with `propagate: false`: cross-text propagation (checking every detected value against every text) accounts for 0.107 ms, 46% of it. Without propagation the 6 texts cost about what `mask`'s size scaling predicts for 2.6 KB (0.0894 ms, interpolated from the ~2 KB and ~10 KB rows), plus 0.0062 ms per text. The first call in a fresh process is much slower (14.6 ms median) while V8 compiles regexes and functions, which matters only for cold starts. These are single-machine numbers with no audit sink: a `JsonlAuditLogger` adds a file append per request, and a different CPU or a busy event loop will shift the absolute values.
