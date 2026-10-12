/** Тул хвоста вывода фонового процесса (bounded, без усечения по бюджету). */
import type { ToolDefinition } from "./types";
import { processRegistry } from "../modules/processes";
import { t } from "../i18n/index";
import { MAX_PREVIEW_LINES } from "./preview";
import { lookupProcess } from "./process-ids";

const DEFAULT_TAIL = MAX_PREVIEW_LINES;
/** Потолок из описания тула; тул вне усечения по бюджету. */
const MAX_TAIL = 300;

/** Показывает буферизированный вывод фонового процесса (последние N строк). */
export const processLogTool: ToolDefinition = {
  name: "process_log",
  security: { caps: [{ proc: true }] },
  icon: "📜",
  description: `Show the buffered output of a background process started via bash. Shows the last ${DEFAULT_TAIL} lines by default. Use after starting a dev server to verify it came up without errors, and while it runs to check its state. For a finite task that should complete, prefer process_wait over polling this tool.`,
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
  handler: async (_ctx, args) => {
    const found = lookupProcess(args);
    if (!found.ok) return { success: false, output: found.output };
    const { id, entry } = found;
    const status =
      entry.status === "running"
        ? t("proc.status_running")
        : entry.status === "exited"
          ? t("proc.status_exited")
          : t("proc.status_killed");
    const tail = Math.min(
      MAX_TAIL,
      Math.max(1, typeof args.tail === "number" ? Math.floor(args.tail) : DEFAULT_TAIL),
    );
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
