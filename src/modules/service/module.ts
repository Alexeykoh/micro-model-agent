/**
 * Модуль `Agent Service API v1`: сборка состояния + старт HTTP-сервера.
 * Публичный контракт отделён от `webui`; внутренности (`RunPool`,
 * `createSessionRunnerFactory`/`spawnSessionRunner`, `Agent`) переиспользуются.
 */
import { createServiceState, type AgentServiceState, type ServiceDeps } from "./state";
import { installServiceLogForwarding } from "./runtime/log-bridge";
import { startServiceServer, stopServiceServer } from "./server";

/** Хендл запущенного сервиса: состояние, URL, стоп. */
export interface ServiceHandle {
  state: AgentServiceState;
  url: Promise<string>;
  stop(): void;
}

/** Создаёт состояние и поднимает сервер; URL резолвится после bind. */
export function startAgentService(deps: ServiceDeps): ServiceHandle {
  const state = createServiceState(deps);
  const stopLogs = installServiceLogForwarding(state);
  const url = startServiceServer(state);
  state.starting = url;
  return {
    state,
    url,
    stop: () => {
      stopLogs();
      stopServiceServer(state);
    },
  };
}

export type { AgentServiceState, ServiceDeps } from "./state";
