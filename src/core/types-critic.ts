// Типы свёрнутого отчёта критика (`OnMeta kind: "critic"`). Вынесены из
// `core/types.ts` (правило ≤300). Без сырых reasoning-токенов и тел файлов.

/** Одно замечание критика в свёрнутом блоке проверки. */
export interface CriticReportIssue {
  severity: string;
  claim: string;
  problem?: string;
  suggestion?: string;
  evidence?: string;
}

/** Одна read-only проверка, которую запросил критик. */
export interface CriticReportCheck {
  tool: string;
  args?: string;
  ok?: boolean;
  output?: string;
}

/**
 * Итог проверки критика для ленты: что именно он смотрел, какие проверки
 * запросил и к какому выводу пришёл.
 */
export interface CriticReport {
  status: "ok" | "concern" | "critical" | "none";
  summary?: string;
  issues: CriticReportIssue[];
  checks: CriticReportCheck[];
  /** Сколько LLM-проходов реально ушло на проверку. */
  passes: number;
  durationMs: number;
  timedOut?: boolean;
}
