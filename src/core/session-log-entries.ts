// Чистые builders записей session-журнала: держат SessionLogger ≤300 (правило 6)
// и не дают формату события расползтись по нескольким файлам.
import type { SessionLogEntry } from "../modules/session/log-types";
import type { RetractInfo } from "./types";

type LogEntry = Omit<SessionLogEntry, "ts" | "source">;

/** `session_start`: окружение, LSP-проба, плагины, скиллы. */
export function sessionStartEntry(data: {
  environment?: Record<string, unknown>;
  lspProbe?: SessionLogEntry["lspProbe"];
  plugins?: string[];
  skills?: number;
}): LogEntry {
  return {
    type: "session_start",
    content: "session started",
    environment: data.environment,
    lspProbe: data.lspProbe,
    plugins: data.plugins,
    skills: data.skills,
  };
}

/** `gate_timing`: сколько стояли hallucination/critic/audit за проход (A15). */
export function gateTimingEntry(d: {
  iteration: number;
  total: number;
  gates: SessionLogEntry["gates"];
}): LogEntry {
  return {
    type: "gate_timing",
    content: `gates ${d.total}ms`,
    iteration: d.iteration,
    duration: d.total,
    gates: d.gates,
  };
}

/** `retract`: отзыв черновика гейтом (причина — в `content`). */
export function retractEntry(info: RetractInfo): LogEntry {
  return {
    type: "retract",
    content: info.reason ?? "",
    retractSource: info.source,
    verdict: info.verdict,
    iteration: info.iteration,
  };
}
