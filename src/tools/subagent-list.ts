/** Тул списка субагентов: что реально работает в этом процессе. */
import type { ToolContext, ToolDefinition, ToolResult } from "./types";
import { t } from "../i18n/index";
import { listSubagentRuns, type RegisteredSubagent } from "./subagent-registry";

/** Обрезает задачу до одной читаемой строки. */
function taskLine(task: string): string {
  const line = task.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/** Строка прогона для модели. */
function formatRun(run: RegisteredSubagent, now: number): string {
  const ageSec = Math.max(0, Math.round(((run.endedAt ?? now) - run.startedAt) / 1000));
  const parts = [
    run.runId,
    run.status,
    run.agent ?? "default",
    `${ageSec}s`,
    taskLine(run.task),
  ];
  if (run.usage?.totalTokens) parts.push(`${run.usage.totalTokens} tok`);
  if (run.error) parts.push(`error: ${run.error.slice(0, 160)}`);
  return parts.join(" | ");
}

/** Хендлер `subagent_list`. */
export async function listSubagents(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const includeFinished = args.include_finished === true;
  const runs = listSubagentRuns(ctx.sessionId).filter(
    (run) => includeFinished || run.status === "running",
  );
  const experts = Object.keys(ctx.config.experts ?? {});
  const expertLine = experts.length
    ? `\n${t("tool.subagent_list_experts", { experts: experts.join(", ") })}`
    : "";
  if (runs.length === 0) {
    return {
      success: true,
      output: `${t("tool.subagent_list_empty")}${expertLine}`,
    };
  }
  const now = Date.now();
  const lines = runs.map((run) => formatRun(run, now));
  return {
    success: true,
    output: `${t("tool.subagent_list_header", { count: String(runs.length) })}\n${lines.join("\n")}${expertLine}`,
  };
}

/** Определение тула `subagent_list`. */
export const subagentListTool: ToolDefinition = {
  name: "subagent_list",
  security: { caps: [{ subagent: true }] },
  icon: "🤖",
  description:
    "List sub-agent runs in the current session (running by default, include_finished for history). Use before claiming that no sub-agents are running: process_list shows shell processes, not sub-agents.",
  tags: ["code"],
  parameters: {
    type: "object",
    properties: {
      include_finished: {
        type: "boolean",
        description: "Also show finished/failed runs (default: only running).",
      },
    },
  },
  handler: listSubagents,
};
