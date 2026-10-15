import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * One record per model call. Contains counts and metadata only: no raw
 * values, no tokens-to-value mappings, no prompt text.
 */
export interface AuditRecord {
  requestId: string;
  /** ISO-8601 time the call started. */
  timestamp: string;
  model: string;
  /** Detections per category across the whole request, including allowed ones. */
  categoryCounts: Record<string, number>;
  blocked: boolean;
  /** Categories that triggered the block, when `blocked` is true. */
  blockedCategories?: string[];
  /** Placeholders appearing in the model output (text and tool inputs). */
  responseReferencedTokens: number;
  /**
   * Damaged or unknown placeholders left unrestored in the output. Tokens held
   * back on purpose by `restoreToolInputs` (`withheld` warnings) are not counted.
   */
  unmaskWarnings: number;
  /**
   * Present when the response contains tool calls: tool name -> category ->
   * number of placeholders actually restored into that tool's input (withheld
   * and escaped `LITERAL` tokens excluded). A tool that was called but received
   * no real values maps to `{}`. Names and counts only, never values.
   */
  toolRestoredTokens?: Record<string, Record<string, number>>;
  latencyMs: number;
  /**
   * Error class name if the request was rejected before reaching the model
   * (other than a policy block) or the upstream call failed: `err.name` unless
   * it is the generic "Error", else the constructor name (SDK error classes
   * such as `RateLimitError` do not set `name`), else "Error". Never the
   * message, which may echo input.
   */
  error?: string;
}

export interface AuditLogger {
  write(record: AuditRecord): void | Promise<void>;
}

export class MemoryAuditLogger implements AuditLogger {
  readonly records: AuditRecord[] = [];

  write(record: AuditRecord): void {
    this.records.push(structuredClone(record));
  }
}

/**
 * Appends one JSON object per line. Writes are serialised through a promise
 * chain so concurrent requests do not interleave partial lines.
 */
export class JsonlAuditLogger implements AuditLogger {
  #queue: Promise<void> = Promise.resolve();
  #dirReady: Promise<string | undefined> | undefined;

  constructor(readonly filePath: string) {}

  write(record: AuditRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    const next = this.#queue.then(async () => {
      this.#dirReady ??= mkdir(dirname(this.filePath), { recursive: true });
      await this.#dirReady;
      await appendFile(this.filePath, line, "utf8");
    });
    // Keep the chain alive after a failure; the caller still sees the rejection.
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Resolves once all queued writes have settled. */
  flush(): Promise<void> {
    return this.#queue;
  }
}
