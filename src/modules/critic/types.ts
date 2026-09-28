// Типы контр-агента: вердикты, замечания и пакет доказательств для проверки.
export type CriticSeverity = "info" | "concern" | "critical";

/** Одно замечание критика: утверждение, проблема, совет, доказательство. */
export interface CriticIssue {
  severity: CriticSeverity;
  claim: string;
  problem: string;
  suggestion?: string;
  evidence?: string;
}

/** Вердикт критика: статус, сводка, замечания, запрошенные read-only проверки. */
export interface CriticVerdict {
  status: "ok" | "concern" | "critical";
  summary: string;
  issues: CriticIssue[];
  /**
   * Запрошенные критиком read-only проверки (Phase 2). Парсятся терпимо —
   * allowlist и кап enforced в `parseChecks` (`src/modules/critic/tools.ts`),
   * вслепую не доверяем.
   */
  checks?: Array<{ tool: string; args?: Record<string, unknown> }>;
}

/** Пакет доказательств: задача, план, изменённые файлы, команды, дайджест тулов. */
export interface EvidencePack {
  task: string;
  planSummary?: string;
  changedFiles: string[];
  commands: Array<{ command: string; exitCode?: number; output?: string }>;
  toolDigest: string;
  /** Ограниченные head-выдержки изменённых файлов (читаются с диска при известном baseDir). Нет, если нечитаемы. */
  fileExcerpts?: Array<{ path: string; excerpt: string }>;
}
