/** Переполнение системного промпта: dry-run, суммаризация, подсказки. */
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { PromptBuilder } from "./prompt-builder";
import type { PromptBlock, PromptBlockKind } from "./types";
import type { LLMProvider } from "../llm/provider";
import type { Logger } from "../logger/app-logger";
import type { AppConfig } from "../config/types";
import { estimateTokens } from "../llm/token-counter";
import { t } from "../i18n/index";

/** Цена model-facing hint-блока в токенах (верхняя граница для аллокации). */
export const HINT_BLOCK_TOKENS = 60;

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

/** Грубый фактор символов на токен для жёсткого усечения. */
const CHARS_PER_TOKEN = 4;

const KIND_ORDER: PromptBlockKind[] = ["instructions", "project-map"];

const KIND_LABEL: Record<PromptBlockKind, string> = {
  instructions: "project instructions (AGENTS.md)",
  "project-map": "project map",
};

const KIND_SOURCE_FILE: Record<PromptBlockKind, string> = {
  instructions: "AGENTS.md",
  "project-map": "",
};

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

function cacheKey(kind: PromptBlockKind, content: string, maxTokens: number): string {
  return createHash("sha256").update(`${kind}|${maxTokens}|${content}`).digest("hex").slice(0, 24);
}

function readCache(cacheDir: string, key: string): { mode: OverflowWarning["mode"]; text: string } | null {
  try {
    const path = join(cacheDir, `${key}.md`);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { mode: OverflowWarning["mode"]; text: string };
      if ((parsed.mode === "summary" || parsed.mode === "truncate") && typeof parsed.text === "string" && parsed.text) {
        return parsed;
      }
    } catch {
      // Легаси plain-text запись — считаем попаданием суммаризации
      return { mode: "summary", text: raw };
    }
    return null;
  } catch {
    // Битый кэш — идём на повторную суммаризацию
  }
  return null;
}

function writeCache(cacheDir: string, key: string, entry: { mode: OverflowWarning["mode"]; text: string }): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, `${key}.md`), JSON.stringify(entry), "utf-8");
  } catch {
    // Best-effort — падение кэша не должно ронять агента
  }
}

/** Собирает полный текстовый ответ через стриминговый API провайдера. */
async function collectText(
  provider: LLMProvider,
  prompt: string,
  maxTokens: number,
  sessionId?: string,
): Promise<string> {
  let text = "";
  // Reasoning выкл: думающая модель сожгла бы cap на <think> до любого
  // суммаризирующего контента (наблюдалось на qwen3.5-9b).
  // 2x запас сверх цели: оценки токенов эвристичны, а clamp ниже держит
  // реальный cap независимо от ответа модели.
  for await (const chunk of provider.chat([{ role: "user", content: prompt }], undefined, undefined, {
    maxTokens: maxTokens * 2,
    reasoningEffort: "none",
    sessionId,
  })) {
    if (chunk.type === "text" && chunk.content) text += chunk.content;
  }
  return text.trim();
}

function truncateToTokens(content: string, maxTokens: number): string {
  const maxChars = Math.max(200, maxTokens * CHARS_PER_TOKEN);
  if (content.length <= maxChars) return content;
  let cut = content.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf("\n");
  if (lastBreak > maxChars * 0.5) cut = cut.slice(0, lastBreak);
  return `${cut.trimEnd()}\n\n[...truncated — read the full file for details...]`;
}

/** Однострочная метка по первой строке (для варнингов/логов). */
function blockLabel(content: string): string {
  const first = content.split("\n")[0].trim();
  return first.length > 60 ? `${first.slice(0, 57)}...` : first;
}

/**
 * Суммаризирует (или, не вышло, усекает) блоки сверх бюджета, чтобы инструкции
 * проекта/карта всё равно дошли до модели. Суммаризации кэшируются на диске
 * (ключ: kind + контент + бюджет). Порядок — KIND_ORDER; первый забирает весь
 * остаток бюджета, остальным — что останется.
 */
export async function resolvePromptOverflow(opts: {
  overflow: PromptBlock[];
  includedTokens: number;
  systemBudget: number;
  provider: LLMProvider | null;
  cacheDir: string;
  logger?: Logger;
  /** Id сессии-владельца: прокидывается в LLM-вызовы для cache/session-заголовков. */
  sessionId?: string;
}): Promise<OverflowResolution> {
  const { overflow, includedTokens, systemBudget, provider, cacheDir, logger, sessionId } = opts;

  const sorted = [...overflow].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind as PromptBlockKind) - KIND_ORDER.indexOf(b.kind as PromptBlockKind),
  );

  const replacements: PromptBlock[] = [];
  const warnings: OverflowWarning[] = [];
  let used = includedTokens;
  const unresolved: PromptBlockKind[] = [];

  // Dry-run bootstrap лишь предупреждает, что блоки «будут суммаризированы
  // перед первым запуском». Без нотиса тут первый промпт выглядит зависшим,
  // пока модель переписывает AGENTS.md / карту — показываем явно.
  if (sorted.length > 0) {
    logger?.warn(t("prompt.overflow.compressing", { count: String(sorted.length) }));
  }

  for (const block of sorted) {
    const kind = block.kind as PromptBlockKind;
    const maxTokens = systemBudget - used - HINT_BLOCK_TOKENS;
    if (maxTokens < 100) {
      unresolved.push(kind);
      continue;
    }

    let mode: OverflowWarning["mode"] = "summary";
    let text = "";

    const key = cacheKey(kind, block.content, maxTokens);
    const cached = readCache(cacheDir, key);
    if (cached) {
      text = cached.text;
      mode = cached.mode;
      logger?.debug(`Prompt overflow: cache hit for ${kind} (${key}, ${mode})`);
    } else if (provider) {
      const targetChars = Math.floor(maxTokens * (CHARS_PER_TOKEN - 1));
      logger?.warn(
        t("prompt.overflow.summarizing", {
          label: blockLabel(block.content),
          original: String(block.estimatedTokens),
          budget: String(maxTokens),
        }),
      );
      try {
        const prompt = [
          `Summarize the following ${KIND_LABEL[kind]} document.`,
          // 3 символа/токен (не 4): нелатиница (кириллица и т.п.) — ~2–3 символа
          // на токен, поэтому цель x4 уводит суммаризацию за clamp.
          `Target length: at most ${targetChars} characters (~${maxTokens} tokens). Be strict about it.`,
          `Preserve concrete facts: file paths, commands, rules, naming conventions, workflow steps.`,
          `Keep the structure (headings / bullet lists). Output ONLY the summary text.`,
          ``,
          `--- DOCUMENT START ---`,
          block.content,
          `--- DOCUMENT END ---`,
        ].join("\n");
        text = await collectText(provider, prompt, maxTokens, sessionId);
        // Маленькие модели регулярно игнорируют лимит длины (наблюдалось: 9B
        // выдала ~4700 символов при цели 3170). Один retry самокомпрессии на
        // перелёт — короткий вход резко повышает послушание — затем жёсткий clamp.
        let retries = 0;
        while (text && estimateTokens(text) > maxTokens && retries < 1) {
          retries++;
          logger?.debug(`Prompt overflow: ${kind} summary overshot (${estimateTokens(text)} > ${maxTokens} tok), compressing (retry ${retries})`);
          text = await collectText(
            provider,
            [
              `Compress the following text to at most ${targetChars} characters.`,
              `Keep the structure (headings / bullet lists) and all concrete facts: file paths, commands, rules.`,
              `Output ONLY the compressed text.`,
              ``,
              `--- TEXT START ---`,
              text,
              `--- TEXT END ---`,
            ].join("\n"),
            maxTokens,
            sessionId,
          );
        }
      } catch (err: any) {
        logger?.warn(
          t("prompt.overflow.summarize_failed", {
            label: blockLabel(block.content),
            error: String(err?.message ?? err),
          }),
        );
        text = "";
      }
    }

    if (!text) {
      // Нет провайдера или суммаризация упала — фолбэк жёсткого усечения.
      mode = "truncate";
      logger?.warn(
        t("prompt.overflow.truncating", {
          label: blockLabel(block.content),
          original: String(block.estimatedTokens),
        }),
      );
      text = truncateToTokens(block.content, maxTokens);
    }

    // LLM перелетают: держим cap независимо от источника текста.
    if (estimateTokens(text) > maxTokens) {
      if (mode === "summary") {
        mode = "truncate";
      }
      text = truncateToTokens(text, maxTokens);
    }
    const resolvedTokens = estimateTokens(text);
    used += resolvedTokens;
    writeCache(cacheDir, key, { mode, text });
    replacements.push({
      content: text,
      priority: "high",
      essential: false,
      estimatedTokens: resolvedTokens,
      kind,
    });
    warnings.push({
      kind,
      label: blockLabel(block.content),
      originalTokens: block.estimatedTokens,
      resolvedTokens,
      mode,
    });
  }

  const hintBlock: PromptBlock | null =
    replacements.length > 0
      ? {
          content: [
            `[Instructions note] Some project blocks exceeded the system-prompt budget and were compressed:`,
            ...warnings.map(
              (w) =>
                `- ${KIND_LABEL[w.kind]}: ${w.originalTokens} tokens → ${w.resolvedTokens} tokens (${w.mode})`,
            ),
            ...(unresolved.length > 0
              ? unresolved.map((k) => `- ${KIND_LABEL[k]}: did not fit at all — read it yourself if needed`)
              : []),
            ...warnings
              .filter((w) => KIND_SOURCE_FILE[w.kind])
              .map((w) => `Read the full ${KIND_SOURCE_FILE[w.kind]} with read_file if details are missing.`),
          ].join("\n"),
          priority: "high",
          essential: true,
          estimatedTokens: HINT_BLOCK_TOKENS,
        }
      : null;

  return { replacements, hintBlock, warnings };
}

/** Откуда настроено активное окно контекста: глобально или запись провайдера. */
export interface ContextWindowSource {
  source: "global" | "entry";
  /** Для "entry": метка записи, задающей contextWindow. */
  label?: string;
  value: number;
}

/**
 * Резолвит источник активного окна контекста (запись провайдера или глобал).
 * @param config конфиг приложения; @returns источник и значение окна.
 */
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
 * Локализованный конкретный фикс переполненного системного промпта. Вместо
 * грубого стандартного размера (проект 32K прыгал бы сразу на 131072) даёт
 * сырое требование и оба рычага: больше окно или больше доля текущего окна.
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
