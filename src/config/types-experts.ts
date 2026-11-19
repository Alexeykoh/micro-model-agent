/**
 * Эксперт субагента: какие тулы дать и на какой модели/провайдере исполнять.
 *
 * Вынесено из `types.ts` (правило 6: файл на потолке строк). Контракт —
 * спека `2026-11-01-experts-model-selection-design`.
 */
export interface ExpertConfig {
  /**
   * Модель эксперта. Пусто/нет — активная модель агента (`config.model`);
   * заданная строка — осознанный пин (см. `resolveExpertProvider`).
   */
  model?: string;
  /** Имя записи `provider.entries[]`. Пусто — активный провайдер. */
  provider?: string;
  tool_tags: string[];
  max_attempts?: number;
  /** Однострочная сводка возможностей эксперта для промпта. */
  description?: string;
}
