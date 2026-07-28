import type { ToolDefinition } from "../tools/registry.js";

/**
 * Определение инструмента subagent для реестра тулов.
 * Позволяет LLM делегировать подзадачи изолированному агенту.
 */
export const subagentDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "subagent",
    description:
      "Delegate a task to an isolated agent with a FRESH context (no history of prior errors). Use for: (1) each file when creating 3+ new files, (2) any task where you are stuck or making repeated errors, (3) simple single-step operations (bash, file read/write). The subagent has all tools and starts clean — ideal when accumulated context is causing confusion.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "What the subagent should do — be specific and include file paths",
        },
        existingFiles: {
          type: "string",
          description:
            "Comma-separated files the subagent can read for context (optional)",
        },
      },
      required: ["task"],
    },
  },
};
