/** Резолвинг переполнения промпта: суммаризация/усечение блоков (кэш — отдельно). */
import type { PromptBlock, PromptBlockKind } from "./types";
import type { OverflowResolution, OverflowWarning } from "./prompt-overflow";
import { buildOverflowHintContent, KIND_LABEL } from "./prompt-overflow";
import type { LLMProvider } from "../llm/provider";
import type { Logger } from "../logger/app-logger";
import { estimateTokens } from "../llm/token-counter";
import { t } from "../i18n/index";
import {
  blockLabel,
  capCompletion,
  CHARS_PER_TOKEN,
  collectText,
  truncateToTokens,
} from "./prompt-overflow-text";
import {
  cacheKey,
  contentHash,
  readCache,
  readSiblingCache,
  writeCache,
} from "./prompt-overflow-cache";

/** Цена model-facing hint-блока в токенах (верхняя граница для аллокации). */
export const HINT_BLOCK_TOKENS = 60;

const KIND_ORDER: PromptBlockKind[] = ["instructions", "project-map"];

/**
 * Суммаризирует (или, не вышло, усекает) блоки сверх бюджета. Суммаризации
 * кэшируются на диске; порядок — KIND_ORDER, первый забирает остаток бюджета.
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
  /** Модель-суммаризатор: чужая выжимка не переиспользуется (B9). */
  model?: string;
  /** Окно контекста: потолок запроса генерации на малых окнах (B10). */
  contextWindow?: number;
}): Promise<OverflowResolution> {
  const { overflow, includedTokens, systemBudget, provider, cacheDir, logger, sessionId } = opts;
  const model = opts.model ?? "unknown";

  const sorted = [...overflow].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind as PromptBlockKind) - KIND_ORDER.indexOf(b.kind as PromptBlockKind),
  );

  const replacements: PromptBlock[] = [];
  const warnings: OverflowWarning[] = [];
  let used = includedTokens;
  const unresolved: PromptBlockKind[] = [];

  // Без нотиса первый промпт выглядит зависшим, пока идёт суммаризация.
  if (sorted.length > 0) {
    logger?.warn(t("prompt.overflow.compressing", { count: String(sorted.length) }));
  }

  for (const block of sorted) {
    const kind = block.kind as PromptBlockKind;
    const maxTokens = systemBudget - used - HINT_BLOCK_TOKENS;
    if (maxTokens < 100) {
      // INV-6: потерянный блок не молчит — warning + hint с back-reference.
      unresolved.push(kind);
      warnings.push({
        kind,
        label: blockLabel(block.content),
        sourceLabel: block.label,
        originalTokens: block.estimatedTokens,
        resolvedTokens: 0,
        mode: "dropped",
      });
      logger?.warn(
        t("prompt.overflow.dropped", {
          label: blockLabel(block.content),
          original: String(block.estimatedTokens),
          budget: String(maxTokens),
        }),
      );
      continue;
    }

    let mode: OverflowWarning["mode"] = "summary";
    let text = "";

    const hash = contentHash(block.content);
    const key = cacheKey(kind, block.content, maxTokens, model);
    const cached = readCache(cacheDir, key);
    if (cached) {
      text = cached.text;
      mode = cached.mode;
      logger?.debug(`Prompt overflow: cache hit for ${kind} (${key}, ${mode})`);
      // Перелёт под новый бюджет режет финальный clamp ниже (режим честно
      // переключится в truncate) — как раньше, без нового LLM-вызова.
    } else {
      // Точный ключ промахнулся (сменился бюджет), но подходит выжимка того же
      // контента той же моделью под другой бюджет — без LLM-вызова (B9).
      const sibling = readSiblingCache(cacheDir, kind, model, hash, maxTokens, logger);
      if (sibling) {
        text = sibling.text;
        mode = sibling.mode;
      } else if (provider) {
        const targetChars = Math.floor(maxTokens * (CHARS_PER_TOKEN - 1));
        logger?.warn(
          t("prompt.overflow.summarizing", {
            label: blockLabel(block.content),
            original: String(block.estimatedTokens),
            budget: String(maxTokens),
          }),
        );
        // B10: 2× запас поверх бюджета, но в пределах окна (на малых окнах
        // вслепую просить 2× — уронить весь вызов суммаризации).
        const contextWindow = opts.contextWindow;
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
          text = await collectText(provider, prompt, capCompletion(maxTokens * 2, prompt, contextWindow), sessionId);
          // Маленькие модели регулярно игнорируют лимит длины (наблюдалось: 9B
          // выдала ~4700 символов при цели 3170). Один retry самокомпрессии на
          // перелёт — короткий вход резко повышает послушание — затем жёсткий clamp.
          let retries = 0;
          while (text && estimateTokens(text) > maxTokens && retries < 1) {
            retries++;
            logger?.debug(`Prompt overflow: ${kind} summary overshot (${estimateTokens(text)} > ${maxTokens} tok), compressing (retry ${retries})`);
            const retryPrompt = [
              `Compress the following text to at most ${targetChars} characters.`,
              `Keep the structure (headings / bullet lists) and all concrete facts: file paths, commands, rules.`,
              `Output ONLY the compressed text.`,
              ``,
              `--- TEXT START ---`,
              text,
              `--- TEXT END ---`,
            ].join("\n");
            text = await collectText(
              provider,
              retryPrompt,
              capCompletion(maxTokens * 2, retryPrompt, contextWindow),
              sessionId,
            );
          }
        } catch (err: unknown) {
          logger?.warn(
            t("prompt.overflow.summarize_failed", {
              label: blockLabel(block.content),
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          text = "";
        }
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
    writeCache(cacheDir, key, { mode, text, kind, model, contentHash: hash, maxTokens });
    replacements.push({
      content: text,
      priority: "high",
      essential: false,
      estimatedTokens: resolvedTokens,
      kind,
      label: block.label,
      source: block.source,
    });
    warnings.push({
      kind,
      label: blockLabel(block.content),
      sourceLabel: block.label,
      originalTokens: block.estimatedTokens,
      resolvedTokens,
      mode,
    });
  }

  const hintContent = buildOverflowHintContent(warnings, unresolved, replacements.length > 0);

  // B4: вес hint-блока — фактический, а не константа. `HINT_BLOCK_TOKENS`
  // остаётся как аллокационный резерв в цикле выше (оценка сверху), но
  // `estimatedTokens` блока обязан отражать реальный текст: иначе бюджет
  // недосчитывает десятки токенов при 2–3 сжатых блоках.
  const hintBlock: PromptBlock | null = hintContent
    ? {
        source: "core",
        label: "overflow note",
        content: hintContent,
        priority: "high",
        essential: true,
        estimatedTokens: estimateTokens(hintContent),
      }
    : null;

  return { replacements, hintBlock, warnings };
}
