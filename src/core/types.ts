export type AgentState = "INIT" | "THINK" | "ACT" | "OBSERVE" | "OUTPUT" | "ERROR";

export interface PromptBlock {
  content: string;
  priority: "critical" | "high" | "normal" | "low";
  essential: boolean;
  estimatedTokens: number;
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
  compactionCount?: number;
  contextQuality?: number;
}
