// Типы MoE-исполнения: план, подзадачи, результаты, scope-запросы.
/** Подзадача MoE: описание, эксперт, файлы, зависимости, критерии успеха. */
export interface MoESubtask {
  id: string;
  description: string;
  expert_tag: string;
  allowed_files: string[];
  read_only_files: string[];
  depends_on: string[];
  input_from: string[];
  expected_output: string;
  success_criteria: string[];
}

/** MoE-план: заголовок, подзадачи, общий контекст (правила, ссылки). */
export interface MoEPlan {
  title: string;
  subtasks: MoESubtask[];
  shared_context: {
    rules: string[];
    refs: string[];
  };
}

/** Результат подзадачи: успех, сводка, вывод/ошибка, длительность, scope-запрос. */
export interface SubtaskResult {
  subtaskId: string;
  success: boolean;
  summary: string;
  result: string;
  error?: string;
  durationMs: number;
  /** Ставится, если упавший сабагент вернул структурированный scope-request блок. */
  scopeRequest?: ScopeRequestBody;
}

/** Машиночитаемый запрос сабагента на доступ к вне-скоп файлам. */
export interface ScopeRequestBody {
  files: string[];
  read_only: boolean;
  reason: string;
}

/**
 * Результат исполнения MoE-плана. `success` — `true`, только если ВСЕ подзадачи
 * успешны. Если упала ХОТЬ ОДНА — даже когда верификация оркестратора
 * скомпенсировала и дала финальный ответ — `success` — `false`, и вызывающий
 * (agent-moe) показывает частичные результаты в финальном тексте. Вердикт
 * оркестратора фейлы подзадач НЕ перекрывает.
 */
export interface PlanResult {
  success: boolean;
  results: SubtaskResult[];
  errors: string[];
  warnings: string[];
  /** Селективный re-plan (Plan 5.1): подзадачи, перенесённые из прошлого цикла. */
  carriedSubtaskIds?: string[];
}
