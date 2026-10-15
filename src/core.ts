/**
 * Browser-safe entry (`pii-gate/core`): detection, masking, unmasking and the
 * in-memory vault and the Anthropic wrapper, with no Node built-ins. The root
 * entry adds the audit loggers.
 */
export type {
  BuiltInCategory,
  Category,
  Detector,
  Finding,
  JsonValue,
  Policy,
  PolicyAction,
} from "./types.js";
export { BUILT_IN_CATEGORIES } from "./types.js";
export { PiiBlockedError, UnsupportedContentError } from "./errors.js";

export {
  addressDetector,
  creditCardDetector,
  defaultDetectors,
  detect,
  dobDetector,
  driversLicenseDetector,
  emailDetector,
  isValidVinCheckDigit,
  luhnValid,
  personDetector,
  phoneDetector,
  regexDetector,
  resolveOverlaps,
  ssnDetector,
  staticDetector,
  vinDetector,
} from "./detectors/index.js";
export type { DetectOptions, MatchContext, RegexDetectorSpec, RegexRule, VinDetectorOptions } from "./detectors/index.js";

export { InMemoryVault, formatToken, hydrate } from "./vault.js";
export type { AsyncVault, RedisLike, RedisVaultFactory, RedisVaultOptions, Vault, VaultEntry } from "./vault.js";

export { collectFindings, mask, maskAll } from "./mask.js";
export type { MaskAllResult, MaskFinding, MaskOptions, MaskResult, SchemaHint, SchemaHints } from "./mask.js";

export { countTokens, unmask, unmaskDeep } from "./unmask.js";
export type { UnmaskDeepResult, UnmaskResult, UnmaskWarning, UnmaskWarningKind } from "./unmask.js";

export type { AuditLogger, AuditRecord } from "./audit.js";

export { wrapAnthropic } from "./anthropic.js";
export type {
  ContentBlockLike,
  CreateParamsLike,
  GateReport,
  MessageLike,
  MessageParamLike,
  MessagesClientLike,
  WrapAnthropicOptions,
  WrappedAnthropic,
} from "./anthropic.js";
