import type { ToolDefinition } from "./types";
import { processRegistry } from "../modules/processes";
import { t } from "../i18n/index";

export const processListTool: ToolDefinition = {
  name: "process_list",
  description:
    "List background processes started via the bash tool (dev servers, watchers, long-running commands). Shows id, pid, command, status, and recent output. Use with process_log and process_kill to inspect or stop them.",
  tags: ["shell"],
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (ctx) => {
    const list = processRegistry.list(ctx.sessionId);
    if (list.length === 0) {
      return { success: true, output: t("proc.none") };
    }

    const statusLabel = (status: string): string => {
      if (status === "running") return t("proc.status_running");
      if (status === "exited") return t("proc.status_exited");
      return t("proc.status_killed");
    };

    const lines = [`${t("proc.list_header")} (${list.length}):`];
    for (const entry of list) {
      const tail = entry.log.length > 0 ? entry.log[entry.log.length - 1] : "";
      const detail = tail ? ` — ${tail.slice(0, 80)}${tail.length > 80 ? "…" : ""}` : "";
      lines.push(
        `  ${entry.id}  PID ${entry.pid}  ${statusLabel(entry.status)}  ${entry.command}${detail}`,
      );
    }
    lines.push(
      `\n${t("proc.hint", {
        list: "process_list",
        log: "process_log",
        kill: "process_kill",
      })}`,
    );
    return { success: true, output: lines.join("\n") };
  },
};
