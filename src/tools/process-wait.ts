/** Тул ожидания завершения фонового процесса (вместо поллинга/сна). */
import type { ToolDefinition } from "./types";
import { processRegistry } from "../modules/processes";
import { t } from "../i18n/index";
import { lookupProcess } from "./process-ids";
import {
  PROCESS_WAIT_DEFAULT_MS as DEFAULT_WAIT_MS,
  PROCESS_WAIT_MAX_MS as MAX_WAIT_MS,
} from "../config/timeouts";

/**
 * Дефолтное ожидание: хватает на типичный тест/билд, но в пределах таймаута
 * исполнителя. `timeoutMs` тула даёт запас под явное долгое ожидание
 * (кламп MAX_WAIT_MS).
  */
const DEFAULT_TAIL = 20;
const MAX_TAIL = 100;

/** Ждёт выхода процесса до timeoutMs; отчитывается кодом и хвостом вывода. */
export const processWaitTool: ToolDefinition = {
  name: "process_wait",
  security: { caps: [{ proc: true }] },
  icon: "⏳",
  description:
    "Wait for a background process started via bash to finish, instead of polling process_log or sleeping (ping/timeout/sleep commands). Blocks up to timeoutMs, then reports whether the process exited (with its exit code and recent output) or is still running. For dev servers/watchers that never exit, use process_log to inspect and process_kill to stop them.",
  tags: ["shell"],
  boundedOutput: true,
  timeoutMs: 120000,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Process id from bash output or process_list" },
      timeoutMs: {
        type: "number",
        description: `How long to wait in milliseconds (default: ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS})`,
      },
      tail: {
        type: "number",
        description: `Number of trailing output lines to include (default: ${DEFAULT_TAIL}, max ${MAX_TAIL})`,
      },
    },
    required: ["id"],
  },
  handler: async (ctx, args) => {
    const found = lookupProcess(args, ctx.sessionId);
    if (!found.ok) return { success: false, output: found.output };
    const { id } = found;
    const waitMs = Math.min(
      MAX_WAIT_MS,
      Math.max(1000, typeof args.timeoutMs === "number" ? Math.floor(args.timeoutMs) : DEFAULT_WAIT_MS),
    );
    const started = Date.now();
    await processRegistry.waitForExit(id, waitMs);
    const elapsed = Date.now() - started;
    const entry = processRegistry.get(id, ctx.sessionId);
    if (!entry) {
      return { success: false, output: t("proc.not_found", { id }) };
    }
    const tail = Math.min(
      MAX_TAIL,
      Math.max(1, typeof args.tail === "number" ? Math.floor(args.tail) : DEFAULT_TAIL),
    );
    const log = processRegistry.getLog(id, tail);
    const logPart = log ? `\n${log}` : `\n${t("proc.log_empty")}`;
    if (entry.status !== "running") {
      const status =
        entry.status === "exited" ? t("proc.status_exited") : t("proc.status_killed");
      return {
        success: true,
        output: `${t("proc.wait_exited", { id, ms: elapsed, status, code: entry.exitCode ?? "?" })}${logPart}`,
      };
    }
    return {
      success: true,
      output: `${t("proc.wait_running", { id, ms: elapsed })}\n${t("proc.wait_hint", { id })}${logPart}`,
    };
  },
};
