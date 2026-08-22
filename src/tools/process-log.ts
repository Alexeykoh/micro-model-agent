import type { ToolDefinition } from "./types";
import { processRegistry } from "../modules/processes";
import { t } from "../i18n/index";
import { MAX_PREVIEW_LINES } from "./preview";

const DEFAULT_TAIL = MAX_PREVIEW_LINES;

export const processLogTool: ToolDefinition = {
  name: "process_log",
  icon: "📜",
  description: `Show the buffered output of a background process started via bash. Shows the last ${DEFAULT_TAIL} lines by default. Use after starting a dev server to verify it came up without errors, and while it runs to check its state.`,
  tags: ["shell"],
  boundedOutput: true,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Process id from bash output or process_list" },
      tail: {
        type: "number",
        description: `Number of trailing lines to show (default: ${DEFAULT_TAIL}, max 300)`,
      },
    },
    required: ["id"],
  },
  handler: async (ctx, args) => {
    if (args.id === undefined || String(args.id).trim() === "") {
      const known = processRegistry.list();
      const ids = known.map((p) => p.id);
      const listPart = ids.length
        ? `\n${t("proc.list_header")}: ${ids.join(", ")}`
        : `\n${t("proc.missing_id_list")}`;
      return { success: false, output: `${t("proc.missing_id")}${listPart}` };
    }
    const id = String(args.id);
    const entry = processRegistry.get(id);
    if (!entry) {
      return { success: false, output: t("proc.not_found", { id }) };
    }
    const status =
      entry.status === "running"
        ? t("proc.status_running")
        : entry.status === "exited"
          ? t("proc.status_exited")
          : t("proc.status_killed");
    const tail = typeof args.tail === "number" ? args.tail : DEFAULT_TAIL;
    const log = processRegistry.getLog(id, tail);
    if (!log) {
      return {
        success: true,
        output: `${t("proc.log_header", { id, status })} ${t("proc.log_empty")}`,
      };
    }
    return {
      success: true,
      output: `${t("proc.log_header", { id, status })}\n${log}`,
    };
  },
};
