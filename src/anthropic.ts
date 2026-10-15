import type { AuditLogger, AuditRecord } from "./audit.js";
import { PiiBlockedError, UnsupportedContentError } from "./errors.js";
import { countByCategory, maskAll, type MaskOptions } from "./mask.js";
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

export interface WrapAnthropicOptions extends Omit<MaskOptions, "vault"> {
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
  /** Called with unmask warnings (tokens only, never values). */
  onUnmaskWarnings?: (warnings: UnmaskWarning[], requestId: string) => void;
}

export interface GateReport {
  requestId: string;
  vault: Vault;
  warnings: UnmaskWarning[];
  categoryCounts: Record<string, number>;
  responseReferencedTokens: number;
}

export interface WrappedAnthropic<P extends CreateParamsLike, R extends MessageLike> {
  messages: {
    create(params: P): Promise<R>;
    /** Same as `create`, plus the vault and unmask warnings for inspection. */
    createWithReport(params: P): Promise<{ message: R; report: GateReport }>;
  };
}

type Rec = Record<string, unknown>;
type StringMapper = (s: string) => string;

/** Blocks that carry no user-supplied free text, or whose signature forbids edits. */
const PASSTHROUGH_TYPES = new Set(["thinking", "redacted_thinking"]);

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mapDeepStrings(value: unknown, fn: StringMapper): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapDeepStrings(v, fn));
  if (isRecord(value)) {
    const out: Rec = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapDeepStrings(v, fn);
    return out;
  }
  return value;
}

class BlockMapper {
  constructor(
    private readonly fn: StringMapper,
    private readonly unsupported: "throw" | "passthrough",
  ) {}

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

function mapParams<P extends CreateParamsLike>(params: P, mapper: BlockMapper): P {
  const messages = params.messages.map((m) => ({ ...m, content: mapper.content(m.content) }));
  const out: Rec = { ...(params as object), messages };
  if (params.system !== undefined) out["system"] = mapper.content(params.system);
  // Only string leaves inside content changed; the object shape is P's.
  return out as unknown as P;
}

/** Every maskable string in `params`, in the same order `mapParams` visits them. */
function collectStrings(params: CreateParamsLike, unsupported: "throw" | "passthrough"): string[] {
  const texts: string[] = [];
  mapParams(params, new BlockMapper((s) => (texts.push(s), s), unsupported));
  return texts;
}

function maskParams<P extends CreateParamsLike>(params: P, options: WrapAnthropicOptions, vault: Vault) {
  const unsupported = options.unsupportedContent ?? "throw";
  const texts = collectStrings(params, unsupported);
  const result = maskAll(texts, { ...options, vault });
  let i = 0;
  const masked = mapParams(params, new BlockMapper(() => result.masked[i++] ?? "", unsupported));
  return { masked, categoryCounts: countByCategory(result.findings.flat()) };
}

/** The declared type says R, but a misconfigured call (e.g. stream) can still return a Stream at runtime. */
function assertMessage(value: unknown): asserts value is MessageLike {
  if (!isRecord(value) || !Array.isArray(value["content"])) {
    throw new UnsupportedContentError("a response that is not a Message (streaming is not supported)");
  }
}

function unmaskMessage<R extends MessageLike>(message: R, vault: Vault) {
  const warnings: UnmaskWarning[] = [];
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
      mapDeepStrings(raw["input"], (s) => ((referenced += countTokens(s)), s));
      const r = unmaskDeep(raw["input"], vault);
      warnings.push(...r.warnings.map((w) => ({ ...w, path: `/content/${index}/input${w.path ?? ""}` })));
      return { ...raw, input: r.value };
    }
    return raw;
  });
  // Same object with only string leaves of content replaced.
  return { message: { ...message, content } as R, warnings, referenced };
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
  async function createWithReport(params: P): Promise<{ message: R; report: GateReport }> {
    const requestId = options.requestId?.() ?? globalThis.crypto.randomUUID();
    const started = Date.now();
    const record = baseRecord(requestId, params.model, started);
    const finish = async (extra: Partial<AuditRecord>): Promise<void> => {
      await options.audit?.write({ ...record, ...extra, latencyMs: Date.now() - started });
    };
    // On a failed request the caller's error is the one that matters; a failing
    // audit sink must not replace it (and wrapping would break `instanceof` checks).
    const finishAfterError = (extra: Partial<AuditRecord>): Promise<void> => finish(extra).catch(() => undefined);
    const errorName = (err: unknown): string => (err instanceof Error ? err.name : "UnknownError");

    let vault: Vault;
    let masked: P;
    try {
      if (params.stream) throw new UnsupportedContentError("streaming requests");
      vault = options.createVault?.() ?? new InMemoryVault();
      ({ masked, categoryCounts: record.categoryCounts } = maskParams(params, options, vault));
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

    const { message, warnings, referenced } = unmaskMessage(response, vault);
    if (warnings.length > 0) options.onUnmaskWarnings?.(warnings, requestId);
    await finish({ responseReferencedTokens: referenced, unmaskWarnings: warnings.length });
    return {
      message,
      report: { requestId, vault, warnings, categoryCounts: record.categoryCounts, responseReferencedTokens: referenced },
    };
  }

  return {
    messages: {
      createWithReport,
      create: async (params) => (await createWithReport(params)).message,
    },
  };
}
