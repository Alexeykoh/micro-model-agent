/** Тул изолированного субагента (свой контекст, скоуп, теги тулов). */
import type { ToolDefinition } from "./types";
import { runSubagent, SUBAGENT_SYSTEM_PROMPT_TEMPLATE } from "./subagent-run";

// Промпт-шаблон субагента живёт в `subagent-run.ts`; реэкспорт для импортёров.
export { SUBAGENT_SYSTEM_PROMPT_TEMPLATE };

/** Спавнит изолированного субагента. Параметры: task, scope-файлы, tool_tags, result_mode. */
export const subagentTool: ToolDefinition = {
  name: "subagent",
  security: { caps: [{ subagent: true }] },
  icon: "🤖",
  description:
    "Spawn an isolated sub-agent to work on a task independently. The sub-agent has its own context and executes autonomously. Use for parallel work or complex sub-tasks.",
  tags: ["code"],
  // Несколько subagent-вызовов одного хода выполняются конкурентно
  // (ToolBatchExecutor запускает их через fork'и, см. tool-batch.ts).
  parallelizable: true,
  timeoutMs: (ctx) => ctx.config?.subagent?.timeoutMs ?? 180000,
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Task description for the sub-agent",
      },
      context: {
        type: "string",
        description: "Optional context or constraints",
      },
      expert_tag: {
        type: "string",
        description:
          "Configured expert tag (from config.experts) — derives the sub-agent's tool_tags. Ignored if tool_tags is given.",
      },
      allowed_files: {
        type: "array",
        items: { type: "string" },
        description: "Files/directories the sub-agent can read and write",
      },
      read_only_files: {
        type: "array",
        items: { type: "string" },
        description: "Files/directories the sub-agent can read but not write",
      },
      tool_tags: {
        type: "array",
        items: { type: "string" },
        description: "Tool tags to expose to the sub-agent",
      },
      result_mode: {
        type: "string",
        enum: ["text", "file"],
        description:
          '"file": persist the full result to an artifact and return a path + summary (pass-by-reference). "text" (default): return the full text into context.',
      },
      artifact_name: {
        type: "string",
        description: "Artifact file name (sanitized). Default: subagent-<timestamp>.",
      },
    },
    required: ["task"],
  },
  handler: runSubagent,
};
