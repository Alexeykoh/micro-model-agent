/** AQC-8: уборка фоновых процессов, запущенных внутри хода. */
import type { AgentDeps } from "../agent";
import type { SessionManager } from "../../modules/session/manager";
import { processRegistry } from "../../modules/processes/registry";

/**
 * Убивает только процессы с `startedAt >= начала хода` — сервер, поднятый
 * пользователем раньше, не трогается. Fail-open с диагностикой (INV-15).
 */
export function stopTurnProcesses(
  sessionManager: SessionManager | undefined,
  deps: AgentDeps,
  turnStartedAt: number,
): void {
  const sessionId = sessionManager?.getActiveMeta?.()?.id;
  try {
    const started = processRegistry
      .list(sessionId)
      .filter((p) => p.status === "running" && Date.parse(p.startedAt) >= turnStartedAt);
    for (const p of started) processRegistry.kill(p.id);
    if (started.length > 0) {
      deps.onDiagnostic?.({
        source: "core",
        operation: "agent.turn.process_cleanup",
        kind: "ok",
        cause: `stopped ${started.length} process(es) started during the turn`,
      });
    }
  } catch (err) {
    deps.onDiagnostic?.({
      source: "core",
      operation: "agent.turn.process_cleanup",
      kind: "failed",
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}
