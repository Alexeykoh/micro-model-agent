/** Тул останова фонового процесса (всё дерево, с детьми). */
import type { ToolDefinition } from "./types";
import { processRegistry } from "../modules/processes";
import { t } from "../i18n/index";
import { lookupProcess } from "./process-ids";

/** Останавливает фоновый процесс по id из bash/process_list. */
export const processKillTool: ToolDefinition = {
  name: "process_kill",
  security: { caps: [{ proc: true }] },
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
  handler: async (_ctx, args) => {
    // Без id отвечаем использованием: голое "not found: undefined" не
    // подсказывает верный формат.
    const found = lookupProcess(args);
    if (!found.ok) return { success: false, output: found.output };
    const { id, entry } = found;
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
