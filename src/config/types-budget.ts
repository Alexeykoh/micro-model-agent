/** Бюджет контекста: пороги промпта, резерва, компакции и admission. */

export interface ContextBudget {
  systemPrompt: number;
  responseReserve: number;
  compactionThreshold: number;
  /**
   * Порог admission (OO-1): результат тула в токенах, выше которого вывод НЕ
   * входит в контекст дословно, а заменяется дескриптором + спиллом. Дефолт 3000;
   * финальное значение — по замеру. Не влияет на security-enforcement.
   */
  admitMaxTokens?: number;
  /**
   * Минимальная загрузка истории (доля), при которой срабатывает интервальная
   * компакция по итерациям. Дефолт 0.5. Не даёт компактить слабозагруженный
   * контекст лишь потому, что прошло N итераций.
   */
  compactionMinLoad?: number;
  /**
   * Политика компакции: `legacy` — поведение 2.18.2, `v2` (дефолт) —
   * канонический порог по истории, cooldown, гарантия прогресса, pinning.
   */
  policy?: "legacy" | "v2";
  /** Мин. число итераций между overflow-компакциями (v2). Дефолт = FORCED_COMPACTION_COOLDOWN. */
  overflowCooldown?: number;
  /** Сколько последних tool-результатов не чистить при компакции (v2). Дефолт 6. */
  toolResultKeep?: number;
  /** Число вызовов прогрева калибровки (cold/warming). Дефолт 3. */
  calibrationWarmup?: number;
  /** Нижняя граница калибровки как доля raw. Дефолт 0.5. */
  ratioFloor?: number;
  /**
   * Сводка компакции: `off` — только task/plan/facts; `ledger` (дефолт) —
   * дополнительно пинить структурный `[Tool ledger]` (что уже прочитано/
   * прочитано/fetched), чтобы модель не переисследовала то же после сжатия.
   */
  compactionSummary?: "off" | "ledger";
}
