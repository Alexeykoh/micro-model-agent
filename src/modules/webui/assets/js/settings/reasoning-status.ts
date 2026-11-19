// Read-only проекция статуса reasoning для веб-селектора: какие уровни
// предлагать и какую оговорку показать. Держится отдельно от DOM, чтобы
// честность вердикта (INV-R7) была проверяема без happy-dom.
export interface ReasoningStatusInfo {
  strategy?: string;
  supported?: boolean | null;
  /** Уровни, объявленные провайдером (INV-R7); null/undefined = не объявлены. */
  levels?: string[] | null;
}

export interface ReasoningStatus {
  /** i18n-ключ оговорки над уровнями; null — оговорки нет. */
  noteKey: string | null;
  /** Доступные уровни: даже при `supported === false` они остаются. */
  levels: string[];
}

/**
 * `supported === false` значит «проба не подтвердила», а не «бэкенд
 * игнорирует»: меню уровней остаётся, добавляется только честная оговорка.
 *
 * Уровни — только объявленные эндпоинтом (INV-R7, свои имена); когда объявлено
 * ничего (`levels` не массив) — показываем лишь режимные `auto`/`default`,
 * а не выдуманные усилия. Проба не подтвердила уровень — не значит, что
 * уровня нет: сервер ничего не объявил, список остаётся пустым.
 */
export function reasoningStatus(info: ReasoningStatusInfo): ReasoningStatus {
  return {
    noteKey: info.supported === false ? "reasoning.probe_failed" : null,
    levels: Array.isArray(info.levels)
      ? ["auto", "default", ...(info.levels ?? [])]
      : ["auto", "default"],
  };
}
