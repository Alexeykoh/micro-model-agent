/** Переполнение системного промпта: dry-run, бюджеты контекста и подсказки. */
import { join } from "path";
import { PromptBuilder } from "./prompt-builder";
import type { PromptBlock, PromptBlockKind } from "./types";
import type { AppConfig } from "../config/types";
import { t } from "../i18n/index";

// Публичный API: резолвинг блоков живёт в prompt-overflow-resolve.ts.
export { HINT_BLOCK_TOKENS, resolvePromptOverflow } from "./prompt-overflow-resolve";

/** Предупреждение о переполнении: блок, токены до/после, режим. */
export interface OverflowWarning {
  kind: PromptBlockKind;
  label: string;
  originalTokens: number;
  resolvedTokens: number;
  mode: "summary" | "truncate";
}

/** Итог резолвинга переполнения: замены, hint-блок, варнинги. */
export interface OverflowResolution {
  /** Блоки-замены (kind сохранён) вместо исключённых оригиналов. */
  replacements: PromptBlock[];
  /** Малый блок: инструкции сжаты, как читать полный файл. Null, если резолвить нечего. */
  hintBlock: PromptBlock | null;
  warnings: OverflowWarning[];
}

/** Итог dry-run: сколько влезло и какие kind-блоки не влезли. */
export interface OverflowDryRun {
  includedTokens: number;
  /** Исключённые блоки с kind (instructions / project-map). */
  overflow: PromptBlock[];
}

/**
 * Статический dry-run бюджета системного промпта: какие kind-блоки не влезают.
 * Нужен bootstrap для стартового баннера и Agent перед первым LLM-вызовом.
 */
export function dryRunOverflow(allBlocks: PromptBlock[], systemBudget: number): OverflowDryRun {
  const builder = new PromptBuilder(systemBudget);
  builder.addBlocks(allBlocks);
  const result = builder.build();
  const includedTokens = result.blocks
    .filter((b) => b.included)
    .reduce((sum, b) => sum + b.tokens, 0);
  const overflow = result.excludedBlocks.filter((b): b is PromptBlock & { kind: PromptBlockKind } =>
    Boolean(b.kind),
  );
  return { includedTokens, overflow };
}

/** Источник активного окна контекста (запись провайдера или глобал). */
export interface ContextWindowSource {
  source: "global" | "entry";
  /** Для "entry": метка записи, задающей contextWindow. */
  label?: string;
  value: number;
}

/** Источник активного окна: запись провайдера (entry) или глобальный конфиг. */
export function resolveContextWindowSource(config: AppConfig): ContextWindowSource {
  const entries = config.provider.entries ?? [];
  const activeLabel = config.provider.active;
  const activeEntry =
    entries.find((e) => e.label && e.label === activeLabel) ??
    (entries.length === 1 ? entries[0] : undefined);
  if (activeEntry?.contextWindow) {
    return { source: "entry", label: activeEntry.label, value: activeEntry.contextWindow };
  }
  return { source: "global", value: config.contextWindow };
}

/**
 * Человеческая подсказка, как поднять окно контекста: глобал (`mma context <N>`)
 * или override записи провайдера (править файл домена провайдера).
 */
export function contextWindowHint(config: AppConfig, configDir: string, recommended: number): string {
  const src = resolveContextWindowSource(config);
  if (src.source === "global") {
    return `run "mma context ${recommended}"`;
  }
  return `edit "${join(configDir, "config", "provider.json")}" → provider.entries[label="${src.label}"].contextWindow = ${recommended}`;
}

/**
 * Ближайший стандартный размер контекста, чей системный бюджет (10%)
 * вмещает `neededSystemTokens`. Фолбэк — крупнейший известный.
 */
export function recommendContextSize(neededSystemTokens: number): number {
  const sizes = [8192, 16384, 32768, 65536, 131072, 262144];
  return (
    sizes.find((s) => Math.floor(s * 0.1) >= neededSystemTokens) ?? sizes[sizes.length - 1]
  );
}

/** Окно контекста, чтобы доля `systemFraction` покрыла `neededTokens`. */
export function requiredContextWindow(neededTokens: number, systemFraction: number): number {
  const fraction = systemFraction > 0 ? systemFraction : 0.1;
  return Math.ceil(neededTokens / fraction);
}

/** Доля системного промпта ТЕКУЩЕГО окна, чтобы покрыть `neededTokens`. */
export function requiredSystemFraction(neededTokens: number, contextWindow: number): number {
  if (contextWindow <= 0) return 1;
  return Math.min(1, Math.ceil((neededTokens / contextWindow) * 100) / 100);
}

/**
 * Локализованный конкретный фикс переполнения: сырое требование + оба рычага
 * (больше окно или больше доля текущего окна), а не грубый стандартный размер.
 */
export function overflowHint(
  config: AppConfig,
  configDir: string | undefined,
  neededTokens: number,
): string {
  const fraction = config.contextBudget?.systemPrompt ?? 0.1;
  const budget = Math.floor(config.contextWindow * fraction);
  const recommended = recommendContextSize(neededTokens);
  const requiredWindow = requiredContextWindow(neededTokens, fraction);
  const requiredFraction = requiredSystemFraction(neededTokens, config.contextWindow);
  const how = configDir
    ? contextWindowHint(config, configDir, recommended)
    : `increase contextWindow (e.g. to ${recommended})`;
  return [
    t("prompt.overflow.hint_needed", {
      needed: neededTokens,
      window: config.contextWindow,
      fraction,
      budget,
    }),
    t("prompt.overflow.hint_window", { required: requiredWindow, recommended, how }),
    t("prompt.overflow.hint_fraction", { fraction: requiredFraction }),
  ].join(" ");
}
