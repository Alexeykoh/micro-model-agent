import type { ToolDefinition } from "./types";
import { processRegistry } from "../modules/processes";
import { t } from "../i18n/index";

export const processKillTool: ToolDefinition = {
  name: "process_kill",
  icon: "⛔",
  description:
    "Stop a background process started via bash (dev server, watcher). Kills the whole process tree (children included). Use the id returned by bash or process_list.",
  tags: ["shell"],
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Process id from bash output or process_list" },
    },
    required: ["id"],
  },
  handler: async (ctx, args) => {
    if (args.id === undefined || String(args.id).trim() === "") {
      // ses_mt4fn58c: `process_kill -p=5173` produced "Process not found:
      // undefined" — no hint about the correct format. Answer with usage.
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
    const killed = processRegistry.kill(id);
    if (!killed) {
      return { success: false, output: t("proc.kill_failed", { id }) };
    }
    return {
      success: true,
      output: t("proc.killed", { id, pid: entry.pid }),
    };
  },
};
