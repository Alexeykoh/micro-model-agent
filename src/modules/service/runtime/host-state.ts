/**
 * Состояние хоста для wire `/v1/host/state` (split W2).
 *
 * Тот же `buildHostState`, что у REPL и web: снапшот не дублируется в сервисе.
 * Будущий ход берётся из пула, план — из раннера сессии (если он уже поднят).
 */
import { buildHostState } from "../../../core/host-state";
import type { HostStateSnapshot } from "../../../core/host";
import type { AgentServiceState } from "../state";

/** Собирает снапшот активной (или заданной) сессии процесса. */
export function hostStateOf(s: AgentServiceState, sessionId?: string): HostStateSnapshot {
  const active = sessionId ?? s.deps.sessionManager?.getActive() ?? undefined;
  const runner = active ? s.pool.getRunner(active) : undefined;
  const execModule = runner?.execModule ?? s.deps.execModule;
  return buildHostState(
    {
      config: s.config,
      ...(s.deps.sessionManager ? { sessionManager: s.deps.sessionManager } : {}),
      ...(execModule ? { execModule } : {}),
      ...(s.deps.baseDir ? { workspace: s.deps.baseDir } : {}),
      ...(s.updateAvailable ? { updateAvailable: s.updateAvailable } : {}),
      ...(active ? { sessionId: active } : {}),
    },
    s.pool.isBusy(active ?? null),
  );
}
