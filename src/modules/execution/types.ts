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

export interface PlanResult {
  success: boolean;
  results: SubtaskResult[];
  errors: string[];
  warnings: string[];
}
