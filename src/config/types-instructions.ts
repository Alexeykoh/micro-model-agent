// Типы инструкций проекта (AGENTS.md / CLAUDE.md / config.sources).
// Вынесено из `types-runtime.ts` (правило ≤300 строк).

/**
 * Обработка промпт-блоков (AGENTS.md, карта проекта), превышающих бюджет
 * системного промпта. При включённом `summarize` переполненный блок суммаризирует
 * LLM в остаток бюджета (кеш в `<project>/.mma/cache/prompt-summaries`); при
 * неуспехе блок режется с маркером, а модели хинтится чтение полного файла.
 */
export interface InstructionsConfig {
  summarize: boolean;
  /** Доп. файлы/glob'ы рядом с workspace (вне discover-обхода AGENTS.md). */
  sources: string[];
  /** Что читать, если в каталоге нет `AGENTS.md`: `claude` → `CLAUDE.md`. */
  fallback: "claude" | "none";
}
