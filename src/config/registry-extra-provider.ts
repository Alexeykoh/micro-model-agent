// Дефы провайдера, бюджета контекста, логов контекста, индексатора и
// reasoning. Вынесены из `registry-extra.ts` (правило 6); порядок внутри
// группы — порядок `EXTRA_DEFS`.
import type { ConfigKeyDef } from "./registry";
import { DEFAULTS } from "./defaults";
import { bool, enumOf, int, share, str } from "./registry-extra-factories";

type ReasoningBound = "low" | "medium" | "high";

const REASONING_BOUNDS = ["low", "medium", "high"] as const;

export const PROVIDER_EXTRA_DEFS: ConfigKeyDef[] = [
  bool("provider.fallback", "provider", false,
    (c) => c.provider.fallback ?? false,
    (c, v) => { c.provider.fallback = v as boolean; }),
  int("provider.maxCompletionTokens", "provider", 512, 128000, 1024, true,
    (c) => c.provider.maxCompletionTokens ?? 8192,
    (c, v) => { c.provider.maxCompletionTokens = v as number; }),

  // Авто-детект окна у провайдера (см. contextAuto в types.ts). Включение
  // через веб дополнительно спрашивает провайдера — см. `applyAutoContext`.
  bool("contextAuto", "budget", true,
    (c) => c.contextAuto !== false,
    (c, v) => { c.contextAuto = v as boolean; }),

  share("contextBudget.compactionThreshold", "budget", false,
    (c) => c.contextBudget.compactionThreshold,
    (c, v) => { c.contextBudget.compactionThreshold = v as number; }),
  share("contextBudget.compactionMinLoad", "budget", false,
    (c) => c.contextBudget.compactionMinLoad ?? DEFAULTS.contextBudget.compactionMinLoad,
    (c, v) => { c.contextBudget.compactionMinLoad = v as number; }),
  enumOf("contextBudget.policy", "budget", ["legacy", "v2"] as const, true,
    (c) => c.contextBudget.policy ?? DEFAULTS.contextBudget.policy,
    (c, v) => { c.contextBudget.policy = v as "legacy" | "v2"; }),
  enumOf("contextBudget.compactionSummary", "budget", ["off", "ledger"] as const, true,
    (c) => c.contextBudget.compactionSummary ?? DEFAULTS.contextBudget.compactionSummary,
    (c, v) => { c.contextBudget.compactionSummary = v as "off" | "ledger"; }),
  int("contextBudget.overflowCooldown", "budget", 1, 20, 1, true,
    (c) => c.contextBudget.overflowCooldown ?? DEFAULTS.contextBudget.overflowCooldown,
    (c, v) => { c.contextBudget.overflowCooldown = v as number; }),
  int("contextBudget.toolResultKeep", "budget", 0, 20, 1, true,
    (c) => c.contextBudget.toolResultKeep ?? DEFAULTS.contextBudget.toolResultKeep,
    (c, v) => { c.contextBudget.toolResultKeep = v as number; }),
  enumOf("contextBudget.toolDigest", "budget", ["full", "failures", "off"] as const, true,
    (c) => c.contextBudget.toolDigest ?? DEFAULTS.contextBudget.toolDigest,
    (c, v) => { c.contextBudget.toolDigest = v as "full" | "failures" | "off"; }),
  int("contextBudget.admitMaxTokens", "budget", 200, 8000, 100, true,
    (c) => c.contextBudget.admitMaxTokens ?? DEFAULTS.contextBudget.admitMaxTokens,
    (c, v) => { c.contextBudget.admitMaxTokens = v as number; }),
  str("contextBudget.notesPath", "budget",
    (c) => c.contextBudget.notesPath ?? DEFAULTS.contextBudget.notesPath,
    (c, v) => { c.contextBudget.notesPath = String(v); }),
  int("contextBudget.ledgerMax", "budget", 10, 5000, 10, true,
    (c) => c.contextBudget.ledgerMax ?? DEFAULTS.contextBudget.ledgerMax,
    (c, v) => { c.contextBudget.ledgerMax = v as number; }),
  int("contextBudget.calibrationWarmup", "budget", 0, 20, 1, true,
    (c) => c.contextBudget.calibrationWarmup ?? DEFAULTS.contextBudget.calibrationWarmup,
    (c, v) => { c.contextBudget.calibrationWarmup = v as number; }),
  share("contextBudget.ratioFloor", "budget", true,
    (c) => c.contextBudget.ratioFloor ?? DEFAULTS.contextBudget.ratioFloor,
    (c, v) => { c.contextBudget.ratioFloor = v as number; }),
  bool("instructions.summarize", "budget", true,
    (c) => c.instructions?.summarize ?? DEFAULTS.instructions.summarize,
    (c, v) => {
      c.instructions ??= structuredClone(DEFAULTS.instructions);
      c.instructions.summarize = v as boolean;
    }),

  bool("contextLog.enabled", "budget", false,
    (c) => c.contextLog?.enabled ?? DEFAULTS.contextLog.enabled,
    (c, v) => {
      c.contextLog ??= structuredClone(DEFAULTS.contextLog);
      c.contextLog.enabled = v as boolean;
    }),
  bool("contextLog.redact", "budget", false,
    (c) => c.contextLog?.redact ?? DEFAULTS.contextLog.redact,
    (c, v) => {
      c.contextLog ??= structuredClone(DEFAULTS.contextLog);
      c.contextLog.redact = v as boolean;
    }),

  int("indexer.maxFiles", "budget", 100, 100000, 100, false,
    (c) => c.indexer?.maxFiles ?? DEFAULTS.indexer.maxFiles,
    (c, v) => {
      c.indexer ??= structuredClone(DEFAULTS.indexer);
      c.indexer.maxFiles = v as number;
    }),
  bool("indexer.respectGitignore", "budget", false,
    (c) => c.indexer?.respectGitignore ?? DEFAULTS.indexer.respectGitignore,
    (c, v) => {
      c.indexer ??= structuredClone(DEFAULTS.indexer);
      c.indexer.respectGitignore = v as boolean;
    }),
  int("indexer.mapTokenBudget", "budget", 200, 20000, 100, false,
    (c) => c.indexer?.mapTokenBudget ?? DEFAULTS.indexer.mapTokenBudget,
    (c, v) => {
      c.indexer ??= structuredClone(DEFAULTS.indexer);
      c.indexer.mapTokenBudget = v as number;
    }),

  enumOf("reasoning.min", "reasoning", REASONING_BOUNDS, true,
    (c) => c.reasoning?.min ?? DEFAULTS.reasoning!.min,
    (c, v) => {
      c.reasoning ??= structuredClone(DEFAULTS.reasoning!);
      c.reasoning.min = v as ReasoningBound;
    }),
  enumOf("reasoning.max", "reasoning", REASONING_BOUNDS, true,
    (c) => c.reasoning?.max ?? DEFAULTS.reasoning!.max,
    (c, v) => {
      c.reasoning ??= structuredClone(DEFAULTS.reasoning!);
      c.reasoning.max = v as ReasoningBound;
    }),
  enumOf("reasoning.baseline", "reasoning", REASONING_BOUNDS, true,
    (c) => c.reasoning?.baseline ?? DEFAULTS.reasoning!.baseline,
    (c, v) => {
      c.reasoning ??= structuredClone(DEFAULTS.reasoning!);
      c.reasoning.baseline = v as ReasoningBound;
    }),
  int("reasoning.overrideCooldown", "reasoning", 1, 60, 1, true,
    (c) => c.reasoning?.overrideCooldown ?? DEFAULTS.reasoning!.overrideCooldown,
    (c, v) => {
      c.reasoning ??= structuredClone(DEFAULTS.reasoning!);
      c.reasoning.overrideCooldown = v as number;
    }),
];
