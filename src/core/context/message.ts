/** Сообщение истории: роль, контент, tool-метаданные. */
import type { ContentPart } from "../../llm/provider";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  name?: string;
  tool_call_id?: string;
  success?: boolean;
  /** Вызов, заблокированный плагином — решение гарда, не реальный фейл. */
  blocked?: boolean;
  arguments?: Record<string, unknown>;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}
