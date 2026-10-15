import type { AuditLogger, AuditRecord } from "./audit.js";
import { PiiBlockedError, PiiGateInvariantError, UnsupportedContentError } from "./errors.js";
import { countByCategory, maskTextsAsync, type MaskAsyncOptions, type MaskInput } from "./mask.js";
import { LITERAL_CATEGORY, addCount, assertValidCategory, nullRecord, type Category } from "./types.js";
import { countTokens, unmask, unmaskDeep, type UnmaskWarning } from "./unmask.js";
import { InMemoryVault, type Vault } from "./vault.js";

/*
 * Minimal structural view of the Anthropic Messages API. The real SDK types
 * are assignable to these, so the SDK stays an optional peer dependency.
 */

export interface ContentBlockLike {
  readonly type: string;
}

export interface MessageParamLike {
  readonly role: string;
  readonly content: string | readonly ContentBlockLike[];
}

export interface CreateParamsLike {
  readonly model: string;
  readonly messages: readonly MessageParamLike[];
  readonly system?: string | readonly ContentBlockLike[] | undefined;
  readonly stream?: boolean | undefined;
}

export interface MessageLike {
  readonly model: string;
  readonly content: readonly ContentBlockLike[];
}

export interface MessagesClientLike<P extends CreateParamsLike, R extends MessageLike> {
  readonly messages: {
    create(params: P): PromiseLike<R>;
  };
}

/** `(toolName, path, category) => restore?`; `path` is a JSON Pointer inside the tool's `input`, e.g. "/body". */
export type ToolRestorePredicate = (tool: string, path: string, category: Category) => boolean;

/**
 * Which placeholders are restored into `tool_use.input` (ADR 0002).
 * - `true` (default): restore everything, as before.
 * - `false`: restore nothing; handlers resolve tokens through the report's vault.
 * - record: per tool name, `true`/`false` or the list of categories to restore.
 *   The `"*"` key is the default for unlisted tools (without it they are restored),
 *   so `{ "*": false, lookup_policy: ["PERSON"] }` is deny-by-default.
 * - predicate: full control per tool, path and category.
 * Text blocks are not affected.
 */
export type RestoreToolInputs =
  | boolean
  | Readonly<Record<string, boolean | readonly Category[]>>
  | ToolRestorePredicate;

/**
 * `detectors` may include async detectors such as `nerDetector` (ADR 0004):
 * every string in the request is run through them before anything is sent.
 */
export interface WrapAnthropicOptions extends Omit<MaskAsyncOptions, "vault" | "keepIssuedPlaceholders"> {
  audit?: AuditLogger;
  /** Default: crypto.randomUUID(). */
  requestId?: () => string;
  /**
   * Default: a fresh InMemoryVault per call. Supply one to scope a vault to a
   * whole conversation instead (see README, "multi-turn").
   */
  createVault?: () => Vault;
  /**
   * What to do with blocks pii-gate cannot read (images, base64 PDFs,
   * server-tool blocks). Default "throw": an unreadable block is an
   * unmasked block.
   */
  unsupportedContent?: "throw" | "passthrough";
  /** Called with unmask warnings, including `withheld` ones (tokens and paths only, never values). */
  onUnmaskWarnings?: (warnings: UnmaskWarning[], requestId: string) => void;
  /**
   * Restore policy for `tool_use.input`. Default `true` (restore everything) in
   * v0.x. Tokens held back stay as placeholders and are reported as `withheld`
   * warnings. Handlers with external side effects (email, HTTP, file or queue
   * writes) should receive placeholders and resolve them on purpose.
   */
  restoreToolInputs?: RestoreToolInputs;
  /**
   * Called when the audit write fails on a request that is already failing
   * (block, unsupported content, upstream error). The original error is still
   * the one thrown. On a successful request an audit failure is thrown instead,
   * and this is not called. Exceptions from the callback itself are ignored.
   */
  onAuditError?: (error: unknown, requestId: string) => void;
}

export interface GateReport {
  requestId: string;
  vault: Vault;
  warnings: UnmaskWarning[];
  categoryCounts: Record<string, number>;
  responseReferencedTokens: number;
  /** Same as the audit field: tool name -> category -> tokens restored into its input. Empty without tool calls. */
  toolRestoredTokens: Record<string, Record<string, number>>;
}

export interface WrappedAnthropic<P extends CreateParamsLike, R extends MessageLike> {
  messages: {
    create(params: P): Promise<R>;
    /** Same as `create`, plus the vault and unmask warnings for inspection. */
    createWithReport(params: P): Promise<{ message: R; report: GateReport }>;
  };
}

type Rec = Record<string, unknown>;
/** `assistant` is true for strings from replayed assistant turns. */
type StringMapper = (s: string, assistant: boolean) => string;

/** Blocks that carry no user-supplied free text, or whose signature forbids edits. */
const PASSTHROUGH_TYPES = new Set(["thinking", "redacted_thinking"]);

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mapDeepStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapDeepStrings(v, fn));
  if (isRecord(value)) {
    // fromEntries defines own properties, so a JSON key "__proto__" stays a key instead of setting the prototype.
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapDeepStrings(v, fn)]));
  }
  return value;
}

class BlockMapper {
  private readonly fn: (s: string) => string;

  constructor(
    fn: StringMapper,
    private readonly unsupported: "throw" | "passthrough",
    assistant: boolean,
  ) {
    this.fn = (s) => fn(s, assistant);
  }

  content(content: string | readonly unknown[]): string | unknown[] {
    return typeof content === "string" ? this.fn(content) : content.map((b) => this.block(b));
  }

  block(raw: unknown): unknown {
    if (!isRecord(raw)) return raw;
    switch (raw["type"]) {
      case "text":
        return { ...raw, text: this.fn(String(raw["text"] ?? "")) };
      case "tool_use":
        // Assistant turns replayed from history hold already-unmasked inputs.
        return { ...raw, input: mapDeepStrings(raw["input"], this.fn) };
      case "tool_result":
        return this.toolResult(raw);
      case "document":
        return this.document(raw);
      default:
        return this.other(raw);
    }
  }

  private toolResult(raw: Rec): Rec {
    const content = raw["content"];
    if (content === undefined) return raw;
    if (typeof content === "string" || Array.isArray(content)) return { ...raw, content: this.content(content) };
    return this.other(raw);
  }

  private document(raw: Rec): Rec {
    const source = raw["source"];
    if (isRecord(source) && source["type"] === "text" && typeof source["data"] === "string") {
      return { ...raw, source: { ...source, data: this.fn(source["data"]) } };
    }
    if (isRecord(source) && source["type"] === "content" && Array.isArray(source["content"])) {
      return { ...raw, source: { ...source, content: this.content(source["content"]) } };
    }
    return this.other(raw);
  }

  private other(raw: Rec): Rec {
    if (PASSTHROUGH_TYPES.has(String(raw["type"])) || this.unsupported === "passthrough") return raw;
    throw new UnsupportedContentError(`content block of type "${String(raw["type"])}"`);
  }
}

function mapParams<P extends CreateParamsLike>(params: P, fn: StringMapper, unsupported: "throw" | "passthrough"): P {
  const messages = params.messages.map((m) => ({
    ...m,
    content: new BlockMapper(fn, unsupported, m.role === "assistant").content(m.content),
  }));
  const out: Rec = { ...(params as object), messages };
  if (params.system !== undefined) out["system"] = new BlockMapper(fn, unsupported, false).content(params.system);
  // Only string leaves inside content changed; the object shape is P's.
  return out as unknown as P;
}

/** Every maskable string in `params`, in the same order `mapParams` visits them. */
function collectStrings(params: CreateParamsLike, unsupported: "throw" | "passthrough"): MaskInput[] {
  const inputs: MaskInput[] = [];
  // Replayed assistant turns may hold tokens the (conversation) vault issued earlier: keep those (ADR 0002).
  mapParams(params, (text, assistant) => (inputs.push({ text, keepIssuedPlaceholders: assistant }), text), unsupported);
  return inputs;
}

/** Thrown when the two traversals of `params` disagree. Carries counts only. */
function traversalMismatch(detail: string): PiiGateInvariantError {
  return new PiiGateInvariantError(`pii-gate internal invariant violated: params changed between traversals (${detail}); refusing to send.`);
}

async function maskParams<P extends CreateParamsLike>(params: P, options: WrapAnthropicOptions, vault: Vault) {
  const unsupported = options.unsupportedContent ?? "throw";
  const inputs = collectStrings(params, unsupported);
  // The second traversal below substitutes these results by position and never reads
  // the strings again, so a caller mutating `params` while detection is awaited cannot
  // slip unmasked text through.
  const result = await maskTextsAsync(inputs, { ...options, vault });
  let i = 0;
  const masked = mapParams(
    params,
    () => {
      const next = result.masked[i];
      if (next === undefined) throw traversalMismatch(`more than ${result.masked.length} strings on the second pass`);
      i++;
      return next;
    },
    unsupported,
  );
  if (i !== result.masked.length) throw traversalMismatch(`${i} of ${result.masked.length} strings on the second pass`);
  return { masked, categoryCounts: countByCategory(result.findings.flat()) };
}

/**
 * Validates `restoreToolInputs` once, at wrap time, and turns it into a
 * predicate. The record form is copied into a Map, so later mutation of the
 * caller's object and prototype keys (`__proto__`, `constructor`) have no effect.
 * Errors name the option and the tool key (configuration, not PII), never values.
 */
function restorePredicate(policy: unknown): ToolRestorePredicate {
  if (policy === undefined || policy === true) return () => true;
  if (policy === false) return () => false;
  if (typeof policy === "function") {
    const fn = policy as ToolRestorePredicate;
    return (tool, path, category) => fn(tool, path, category) === true;
  }
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new TypeError("Invalid restoreToolInputs: expected a boolean, a record of per-tool rules, or a function.");
  }
  const rules = new Map<string, boolean | ReadonlySet<string>>();
  for (const [tool, rule] of Object.entries(policy)) {
    if (typeof rule === "boolean") {
      rules.set(tool, rule);
    } else if (Array.isArray(rule)) {
      const categories = new Set<string>();
      for (const category of rule as unknown[]) {
        if (typeof category !== "string") {
          throw new TypeError(`Invalid restoreToolInputs rule for tool "${tool}": categories must be strings.`);
        }
        assertValidCategory(category);
        categories.add(category);
      }
      rules.set(tool, categories);
    } else {
      throw new TypeError(
        `Invalid restoreToolInputs rule for tool "${tool}": expected true, false or an array of categories.`,
      );
    }
  }
  return (tool, _path, category) => {
    const rule = rules.get(tool) ?? rules.get("*") ?? true;
    return typeof rule === "boolean" ? rule : rule.has(category);
  };
}

/** Key used for a tool_use block whose `name` is missing or empty. */
const UNNAMED_TOOL = "(unnamed)";

/** The declared type says R, but a misconfigured call (e.g. stream) can still return a Stream at runtime. */
function assertMessage(value: unknown): asserts value is MessageLike {
  if (!isRecord(value) || !Array.isArray(value["content"])) {
    throw new UnsupportedContentError("a response that is not a Message (streaming is not supported)");
  }
}

function unmaskMessage<R extends MessageLike>(message: R, vault: Vault, restore: ToolRestorePredicate) {
  const warnings: UnmaskWarning[] = [];
  // Tool names come from model output: null-prototype maps so "__proto__" etc. stay ordinary keys.
  const toolRestored = nullRecord<Record<string, number>>();
  let referenced = 0;
  const content = message.content.map((raw, index) => {
    if (!isRecord(raw)) return raw;
    if (raw["type"] === "text" && typeof raw["text"] === "string") {
      referenced += countTokens(raw["text"]);
      const r = unmask(raw["text"], vault);
      warnings.push(...r.warnings.map((w) => ({ ...w, path: `/content/${index}/text` })));
      return { ...raw, text: r.text };
    }
    if (raw["type"] === "tool_use" && isRecord(raw["input"])) {
      const name = raw["name"];
      const tool = typeof name === "string" && name !== "" ? name : UNNAMED_TOOL;
      mapDeepStrings(raw["input"], (s) => ((referenced += countTokens(s)), s));
      const r = unmaskDeep(raw["input"], vault, {
        shouldRestore: (_token, category, path) => restore(tool, path, category),
      });
      warnings.push(...r.warnings.map((w) => ({ ...w, path: `/content/${index}/input${w.path ?? ""}` })));
      const counts = toolRestored[tool] ?? nullRecord<number>();
      toolRestored[tool] = counts;
      for (const [category, n] of Object.entries(r.restoredByCategory)) {
        if (category !== LITERAL_CATEGORY) addCount(counts, category, n);
      }
      return { ...raw, input: r.value };
    }
    return raw;
  });
  // Same object with only string leaves of content replaced.
  return { message: { ...message, content } as R, warnings, referenced, toolRestored };
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * A class-level identifier for an error, never its message. SDK error classes
 * (e.g. Anthropic's `RateLimitError`) do not set `name`, so fall back to the
 * constructor name.
 */
function errorName(err: unknown): string {
  if (!(err instanceof Error)) return "UnknownError";
  const name: unknown = err.name;
  if (typeof name === "string" && name !== "Error" && IDENTIFIER.test(name)) return name;
  const ctor: unknown = (err as { constructor?: unknown }).constructor;
  const ctorName: unknown = typeof ctor === "function" ? ctor.name : undefined;
  if (typeof ctorName === "string" && ctorName !== "Error" && ctorName !== "Object" && IDENTIFIER.test(ctorName)) {
    return ctorName;
  }
  return "Error";
}

function baseRecord(requestId: string, model: string, started: number): AuditRecord {
  return {
    requestId,
    timestamp: new Date(started).toISOString(),
    model,
    categoryCounts: {},
    blocked: false,
    responseReferencedTokens: 0,
    unmaskWarnings: 0,
    latencyMs: 0,
  };
}

/**
 * Wraps an Anthropic client so every `messages.create` call is masked on the
 * way out and unmasked on the way back. Non-streaming only.
 *
 * With the real SDK, pin the types explicitly:
 * `wrapAnthropic<MessageCreateParamsNonStreaming, Message>(new Anthropic())`.
 */
export function wrapAnthropic<P extends CreateParamsLike = CreateParamsLike, R extends MessageLike = MessageLike>(
  client: MessagesClientLike<P, R>,
  options: WrapAnthropicOptions = {},
): WrappedAnthropic<P, R> {
  const restore = restorePredicate(options.restoreToolInputs);
  async function createWithReport(params: P): Promise<{ message: R; report: GateReport }> {
    const requestId = options.requestId?.() ?? globalThis.crypto.randomUUID();
    const started = Date.now();
    const record = baseRecord(requestId, params.model, started);
    const finish = async (extra: Partial<AuditRecord>): Promise<void> => {
      await options.audit?.write({ ...record, ...extra, latencyMs: Date.now() - started });
    };
    // On a failed request the caller's error is the one that matters; a failing
    // audit sink must not replace it (and wrapping would break `instanceof` checks).
    const finishAfterError = (extra: Partial<AuditRecord>): Promise<void> =>
      finish(extra).catch((auditErr: unknown) => {
        try {
          options.onAuditError?.(auditErr, requestId);
        } catch {
          // The caller's original error still wins.
        }
      });

    let vault: Vault;
    let masked: P;
    try {
      if (params.stream) throw new UnsupportedContentError("streaming requests");
      vault = options.createVault?.() ?? new InMemoryVault();
      ({ masked, categoryCounts: record.categoryCounts } = await maskParams(params, options, vault));
    } catch (err) {
      await finishAfterError(
        err instanceof PiiBlockedError
          ? { blocked: true, blockedCategories: err.categories, categoryCounts: { ...err.counts } }
          : { error: errorName(err) },
      );
      throw err;
    }

    let response: R;
    try {
      response = await client.messages.create(masked);
      assertMessage(response);
    } catch (err) {
      await finishAfterError({ error: errorName(err) });
      throw err;
    }

    let unmasked: ReturnType<typeof unmaskMessage<R>>;
    try {
      unmasked = unmaskMessage(response, vault, restore);
      if (unmasked.warnings.length > 0) options.onUnmaskWarnings?.(unmasked.warnings, requestId);
    } catch (err) {
      // A throwing restore predicate or callback still leaves exactly one audit row.
      await finishAfterError({ error: errorName(err) });
      throw err;
    }
    const { message, warnings, referenced, toolRestored } = unmasked;
    const hasTools = Object.keys(toolRestored).length > 0;
    await finish({
      responseReferencedTokens: referenced,
      unmaskWarnings: warnings.filter((w) => w.kind !== "withheld").length,
      ...(hasTools ? { toolRestoredTokens: toolRestored } : {}),
    });
    return {
      message,
      report: {
        requestId,
        vault,
        warnings,
        categoryCounts: record.categoryCounts,
        responseReferencedTokens: referenced,
        toolRestoredTokens: toolRestored,
      },
    };
  }

  return {
    messages: {
      createWithReport,
      create: async (params) => (await createWithReport(params)).message,
    },
  };
}
