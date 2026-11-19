/** Тул остановки конкретного прогона субагента по runId. */
import type { ToolContext, ToolDefinition, ToolResult } from "./types";
import { t } from "../i18n/index";
import { stopSubagentRun } from "./subagent-registry";

/** Хендлер `subagent_stop`. */
export async function stopSubagent(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const runId = String(args.run_id ?? args.runId ?? "").trim();
  if (!runId) {
    return { success: false, output: t("tool.subagent_stop_run_id_required") };
  }
  const status = stopSubagentRun(runId, ctx.sessionId);
  if (status === "ok") {
    return { success: true, output: t("tool.subagent_stop_ok", { runId }) };
  }
  if (status === "not_running") {
    return { success: false, output: t("tool.subagent_stop_not_running", { runId }) };
  }
  return { success: false, output: t("tool.subagent_stop_not_found", { runId }) };
}

/** Определение тула `subagent_stop`. */
export const subagentStopTool: ToolDefinition = {
  name: "subagent_stop",
  security: { caps: [{ subagent: true }] },
  icon: "🤖",
  description:
    "Stop one running sub-agent by runId (see subagent_list). The run is interrupted and its result returns as interrupted.",
  tags: ["code"],
  parameters: {
    type: "object",
    properties: {
      run_id: {
        type: "string",
        description: "Run id from subagent_list (e.g. srun_...).",
      },
    },
    required: ["run_id"],
  },
  handler: stopSubagent,
};
