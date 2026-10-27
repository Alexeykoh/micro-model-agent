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
    "Spawn an isolated sub-agent to work on a task independently. The sub-agent has its own context and executes autonomously. Use for parallel work or complex sub-tasks. Use subagent_list to see running sub-agents (and configured expert_tag values) and subagent_stop to stop one.",
  tags: ["code"],
  // Несколько subagent-вызовов одного хода выполняются конкурентно
  // (ToolBatchExecutor запускает их через fork'и, см. tool-batch.ts).
  parallelizable: true,
  // Executor — только страховка: внутренний watchdog гасит по idle/максимуму.
  timeoutMs: (ctx) => (ctx.config?.subagent?.maxDurationMs ?? 1800000) + 60000,
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
        description:
          "Files/directories the sub-agent can read and write. Restricts file tools (read_file, write_file, grep path) and is the write permission for shell; it does NOT restrict the shell's view — bash/grep see the whole project (see tool_tags to deny shell).",
      },
      read_only_files: {
        type: "array",
        items: { type: "string" },
        description: "Files/directories the sub-agent can read but not write",
      },
      max_tokens: {
        type: "number",
        description:
          "Completion budget of one generation (reasoning + answer), 1..32000. If it runs out before any answer arrives, the harness retries once with a doubled budget. Omit to use the provider default.",
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

/**
 * Тул `subagent` с перечисленными `expert_tag` из конфига.
 *
 * Схема тула собирается один раз при регистрации, а конфиг известен только в
 * bootstrap — поэтому список тегов вписывается там (спека не нужна: контракт
 * аргументов не меняется, меняется текст подсказки). Без этого модель угадывает
 * тег по имени скилла (`code-review`) и повторяет тот же вызов
 * (`ses_mvoac9q9`, дефект D5).
 */
export function subagentToolWithExperts(tags: string[]): ToolDefinition {
  if (tags.length === 0) return subagentTool;
  const list = tags.join(", ");
  const params = subagentTool.parameters as {
    type: "object";
    properties: Record<string, { description?: string }>;
    required?: string[];
  };
  const expert = params.properties.expert_tag ?? {};
  return {
    ...subagentTool,
    description: `${subagentTool.description} Configured expert_tag values: ${list}.`,
    parameters: {
      ...params,
      properties: {
        ...params.properties,
        expert_tag: {
          ...expert,
          description: `${expert.description ?? ""} One of: ${list}. This is a configured expert, NOT a skill name — skills are loaded with load_skill; use tool_tags to pick tools explicitly.`,
        },
      },
    },
  };
}
