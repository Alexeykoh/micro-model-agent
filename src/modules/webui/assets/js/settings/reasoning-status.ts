// Read-only проекция статуса reasoning для веб-селектора: какие уровни
// предлагать и какую оговорку показать. Держится отдельно от DOM, чтобы
// честность вердикта (INV-R7) была проверяема без happy-dom.
export interface ReasoningStatusInfo {
  strategy?: string;
  supported?: boolean | null;
}

export interface ReasoningStatus {
  /** i18n-ключ оговорки над уровнями; null — оговорки нет. */
  noteKey: string | null;
  /** Доступные уровни: даже при `supported === false` они остаются. */
  levels: string[];
}

const REASONING_LEVELS_FULL = ["auto", "default", "none", "low", "medium", "high", "max"];
// Backends without granularity (prompt-tag, template-kwarg) collapse
// medium/max into low/high — show the collapsed set, no duplicates.
const REASONING_LEVELS_COARSE = ["auto", "default", "none", "low", "high"];

/**
 * `supported === false` значит «проба не подтвердила», а не «бэкенд
 * игнорирует»: меню уровней остаётся, добавляется только честная оговорка.
 */
export function reasoningStatus(info: ReasoningStatusInfo): ReasoningStatus {
  return {
    noteKey: info.supported === false ? "reasoning.probe_failed" : null,
    levels: info.strategy === "openai-effort" ? REASONING_LEVELS_FULL : REASONING_LEVELS_COARSE,
  };
}
