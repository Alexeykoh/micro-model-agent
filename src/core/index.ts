/** Ядро агента: реэкспорт Agent, PromptBuilder и базовых типов. */
export { PromptBuilder } from "./prompt-builder";
export { Agent } from "./agent";
export type { AgentDeps } from "./agent";
export type { AgentModule } from "../modules/types";
export type {
  AgentState,
  AgentResult,
  PromptBlock,
  ToolCall,
  ToolResult,
  LLMResponse,
  AgentContext,
  HallucinationResult,
} from "./types";
