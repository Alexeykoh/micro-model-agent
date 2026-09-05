export type AgentState = "INIT" | "THINK" | "ACT" | "OBSERVE" | "OUTPUT" | "ERROR";

/** Semantic class of a prompt block — lets the overflow resolver treat
 *  instructions / project map specially when they exceed the system budget. */
export type PromptBlockKind = "instructions" | "project-map";

export interface PromptBlock {
  content: string;
  priority: "critical" | "high" | "normal" | "low";
  essential: boolean;
  estimatedTokens: number;
  kind?: PromptBlockKind;
}

export type ToolCallStatus = "done" | "failed" | "skipped";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolEvent {
  type: "start" | "end";
  tool: string;
  args: Record<string, unknown>;
  icon?: string;
  duration?: number;
  error?: boolean;
  ctxDelta?: number;
  /** Running session cost in USD at the time the tool finished (if pricing known). */
  costUsd?: number;
  /** Provider name that serviced the tool call (multi-provider mode). */
  provider?: string;
  /** Model that serviced the tool call. */
  model?: string;
}

/** Agent lifecycle phases surfaced to the renderer (spinner control). */
export type AgentPhase = "thinking" | "done";

export interface ToolResult {
  success: boolean;
  output: string;
  toolCallId?: string;
}

export type LLMResponse =
  | { type: "text"; content: string }
  | { type: "tool_call"; calls: ToolCall[] }
  | { type: "reasoning"; content: string };

export interface AgentContext {
  state: AgentState;
  config: import("../config/types").AppConfig;
  messages: Array<{ role: string; content: string | import("../llm/provider").ContentPart[] }>;
  toolResults: ToolResult[];
  iterationCount: number;
  currentStep?: number;
  totalSteps?: number;
}

export interface HallucinationResult {
  status: "pass" | "warn" | "retry" | "block";
  reason?: string;
}

export interface SubtaskContext {
  expert_tag: string;
  tool_tags: string[];
  allowed_files: string[];
  read_only_files: string[];
  shared_context?: {
    rules: string[];
    refs: string[];
  };
  input_from?: string[];
}

export interface AgentResult {
  success: boolean;
  text: string;
  error?: string;
  iterationCount: number;
  contextUsed?: number;
  contextLimit?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Running session cost in USD (undefined when no model price is known). */
  totalCost?: number;
  /** Per-provider cost attribution (priced providers only, cost desc). */
  costBreakdown?: Array<{ provider: string; cost: number }>;
  compactionCount?: number;
  contextQuality?: number;
  /** Provider name that serviced this run. */
  provider?: string;
  /** Model name used for this run. */
  model?: string;
  /** Total wall-clock duration in milliseconds. */
  durationMs?: number;
  /** Total LLM call duration in milliseconds (excludes tool execution). */
  llmDurationMs?: number;
  /**
   * True when the MoE path actually executed (not fell back to the
   * single-agent loop). Used by Agent.run to know whether it must write the
   * assistant turn into context/session (the single-agent loop writes its own).
   */
  moeHandled?: boolean;
}
