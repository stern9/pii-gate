import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlAuditLogger, MemoryAuditLogger, type AuditRecord } from "../src/index.js";

const record = (requestId: string): AuditRecord => ({
  requestId,
  timestamp: "2024-06-11T15:00:00.000Z",
  model: "claude-test",
  categoryCounts: { SSN: 1, PERSON: 2 },
  blocked: false,
  responseReferencedTokens: 3,
  unmaskWarnings: 0,
  latencyMs: 12,
});

describe("audit loggers", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("MemoryAuditLogger stores copies", () => {
    const logger = new MemoryAuditLogger();
    const r = record("a");
    logger.write(r);
    r.categoryCounts["SSN"] = 99;
    expect(logger.records[0]?.categoryCounts["SSN"]).toBe(1);
  });

  it("JsonlAuditLogger appends one parseable line per record, in order, under concurrency", async () => {
    dir = await mkdtemp(join(tmpdir(), "pii-gate-"));
    const file = join(dir, "nested", "audit.jsonl");
    const logger = new JsonlAuditLogger(file);
    await Promise.all(Array.from({ length: 25 }, (_, i) => logger.write(record(`r${i}`))));
    await logger.flush();
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(25);
    expect(lines.map((l) => (JSON.parse(l) as AuditRecord).requestId)).toEqual(
      Array.from({ length: 25 }, (_, i) => `r${i}`),
    );
  });
});
