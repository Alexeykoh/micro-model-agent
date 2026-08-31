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

export interface MoEPlan {
  title: string;
  subtasks: MoESubtask[];
  shared_context: {
    rules: string[];
    refs: string[];
  };
}

export interface SubtaskResult {
  subtaskId: string;
  success: boolean;
  summary: string;
  result: string;
  error?: string;
  durationMs: number;
  /** Set when a failed sub-agent reported a structured scope-request block. */
  scopeRequest?: ScopeRequestBody;
}

/** Machine-readable request from a sub-agent for access to out-of-scope files. */
export interface ScopeRequestBody {
  files: string[];
  read_only: boolean;
  reason: string;
}

/**
 * Result of executing a MoE plan. `success` is `true` only when ALL
 * subtasks succeed. If ANY subtask fails — even when the orchestrator's
 * verification step compensates and produces a final answer — `success`
 * is `false` and the caller (agent-moe) should surface the partial
 * results in the final response text. The orchestrator's verdict does
 * NOT override individual subtask failure.
 */
export interface PlanResult {
  success: boolean;
  results: SubtaskResult[];
  errors: string[];
  warnings: string[];
  /** Selective re-plan (Plan 5.1): subtasks carried over from a previous cycle. */
  carriedSubtaskIds?: string[];
}
