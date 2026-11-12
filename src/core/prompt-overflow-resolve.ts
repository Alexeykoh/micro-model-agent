/** Резолвинг переполнения промпта: суммаризация/усечение блоков (кэш — отдельно). */
import type { PromptBlock, PromptBlockKind } from "./types";
import type { OverflowResolution, OverflowWarning } from "./prompt-overflow";
import type { LLMProvider } from "../llm/provider";
import type { Logger } from "../logger/app-logger";
import { estimateTokens } from "../llm/token-counter";
import { t } from "../i18n/index";
import {
  cacheKey,
  contentHash,
  readCache,
  readSiblingCache,
  writeCache,
} from "./prompt-overflow-cache";

/** Цена model-facing hint-блока в токенах (верхняя граница для аллокации). */
export const HINT_BLOCK_TOKENS = 60;

/** Грубый фактор символов на токен для стартовой догадки усечения (B8: латиница). */
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
 * Потолок запроса генерации под окно контекста (B10): просить `2×maxTokens`
 * вслепую опасно на малых окнах — вход (целый AGENTS.md) плюс запрос могут
 * не влезть, и суммаризация упадёт целиком. Без окна — старое поведение.
 */
function capCompletion(requested: number, promptText: string, contextWindow?: number): number {
  if (!contextWindow || contextWindow <= 0) return requested;
  const cap = contextWindow - estimateTokens(promptText) - 256;
  if (cap < 256) return Math.min(requested, 256);
  return Math.min(requested, cap);
}

/** Собирает полный текстовый ответ через стриминговый API провайдера. */
async function collectText(
  provider: LLMProvider,
  prompt: string,
  maxTokens: number,
  sessionId?: string,
): Promise<string> {
  let text = "";
  // Reasoning выкл. Механизм ("none" → /no_think у prompt-tag, reasoning_effort
  // у openai-effort) выбирает САМ провайдер из своей стратегии (INV-R1) — здесь
  // её знать не нужно и нельзя забыть.
  // 2x запас: оценки эвристичны, clamp ниже держит реальный cap (B10: cap —
  // на вызывающей стороне, сюда приходит уже финальное число).
  for await (const chunk of provider.chat([{ role: "user", content: prompt }], undefined, undefined, {
    maxTokens,
    reasoningEffort: "none",
    sessionId,
  })) {
    if (chunk.type === "text" && chunk.content) text += chunk.content;
  }
  return text.trim();
}

/**
 * Жёсткое усечение с гарантией бюджета (B8): фиксированный делитель врёт на
 * нелатинице (кириллица ~2.5 симв/ток — срез «до N×4 символов» даёт ~1.6×N
 * токенов и бюджет рвётся именно на русском тексте). Поэтому режем итеративно
 * до `estimateTokens(cut) ≤ maxTokens`, маркер обрезки входит в бюджет.
 */
function truncateToTokens(content: string, maxTokens: number): string {
  if (estimateTokens(content) <= maxTokens) return content;
  const suffix = "\n\n[...truncated — read the full file for details...]";
  const suffixTokens = estimateTokens(suffix);
  const bodyBudget = Math.max(1, maxTokens - suffixTokens);
  let maxChars = Math.max(200, bodyBudget * CHARS_PER_TOKEN);
  let cut = content;
  for (let i = 0; i < 3; i++) {
    cut = content.slice(0, maxChars);
    const lastBreak = cut.lastIndexOf("\n");
    if (lastBreak > maxChars * 0.5) cut = cut.slice(0, lastBreak);
    const tokens = estimateTokens(cut);
    if (tokens <= bodyBudget) break;
    maxChars = Math.max(200, Math.floor((maxChars * bodyBudget) / tokens));
  }
  cut = cut.trimEnd();
  while (estimateTokens(cut + suffix) > maxTokens && cut.length > 200) {
    cut = cut.slice(0, Math.floor(cut.length * 0.8)).trimEnd();
  }
  return `${cut}${suffix}`;
}

/** Однострочная метка по первой строке (для варнингов/логов). */
function blockLabel(content: string): string {
  const first = content.split("\n")[0].trim();
  return first.length > 60 ? `${first.slice(0, 57)}...` : first;
}

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
    });
    warnings.push({
      kind,
      label: blockLabel(block.content),
      originalTokens: block.estimatedTokens,
      resolvedTokens,
      mode,
    });
  }

  const hintContent =
    replacements.length > 0
      ? [
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
        ].join("\n")
      : null;

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
