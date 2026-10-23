/**
 * Progress watchdog for a subagent run.
 *
 * The run stays alive while it produces observable events (text, reasoning,
 * notes, tools, phases). Silence longer than `idleMs` or a total run longer than
 * `maxMs` calls `stop()` once. Extracted from `subagent-run.ts` (rule 6).
 */
import { t } from "../i18n/index";

/** Причина остановки вотчдогом. */
export type WatchdogReason = "idle" | "max";

export interface SubagentWatchdog {
  /** Отметить активность (сбрасывает idle-таймер). */
  touch(): void;
  /** Причина срабатывания или null, если прогон ещё жив. */
  reason(): WatchdogReason | null;
  /** Локализованное объяснение для `end`/tool-result. */
  message(): string | null;
  /** Остановить таймер (finally прогона). */
  dispose(): void;
}

export interface SubagentWatchdogOptions {
  idleMs: number;
  maxMs: number;
  /** Остановить дочернего агента (идемпотентно). */
  stop(): void;
}

/** Создаёт вотчдог и запускает его таймер (`unref`, не держит процесс). */
export function createSubagentWatchdog(opts: SubagentWatchdogOptions): SubagentWatchdog {
  const idleMs = Math.max(1000, opts.idleMs);
  const maxMs = Math.max(1000, opts.maxMs);
  const startedAt = Date.now();
  let lastActivity = startedAt;
  let reason: WatchdogReason | null = null;
  const tickMs = Math.max(10, Math.min(1000, Math.floor(Math.min(idleMs, maxMs) / 4)));
  const timer = setInterval(() => {
    if (reason) return;
    const now = Date.now();
    if (now - startedAt >= maxMs) reason = "max";
    else if (now - lastActivity >= idleMs) reason = "idle";
    else return;
    opts.stop();
  }, tickMs);
  timer.unref?.();

  return {
    touch(): void {
      lastActivity = Date.now();
    },
    reason(): WatchdogReason | null {
      return reason;
    },
    message(): string | null {
      if (reason === "idle") {
        return t("tool.subagent_idle_timeout", { seconds: String(Math.round(idleMs / 1000)) });
      }
      if (reason === "max") {
        return t("tool.subagent_max_duration", { minutes: String(Math.round(maxMs / 60000)) });
      }
      return null;
    },
    dispose(): void {
      clearInterval(timer);
    },
  };
}
