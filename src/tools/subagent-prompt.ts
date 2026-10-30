// Системный промпт субагента: вынесено из `subagent-run.ts` (правило ≤300).

/** Фиксированный системный промпт (KV-cache дружит при stableSystemPrompt). */
export const SUBAGENT_SYSTEM_PROMPT_TEMPLATE = `You are a sub-agent working on a specific task. You have your own context window and tool set.

Workflow rules:
- Prefer small, focused steps. Verify your own work (typecheck/tests) before finishing.
- For large outputs, write the result to a file with write_file instead of reproducing it in your answer.
- If the task is big and decomposable, delegate parts to the subagent tool instead of doing everything in one context.
- When you finish, return a concise final answer; do not repeat file contents verbatim if you already wrote them to disk.`;

/** Собирает системный промпт субагента (стабильный или с контекстом). */
export function buildSubagentSystemPrompt(context: string, stable: boolean): string {
  if (stable) return SUBAGENT_SYSTEM_PROMPT_TEMPLATE;
  return `You are a sub-agent working on a specific task. ${context ? `Context: ${context}` : ""}`;
}
