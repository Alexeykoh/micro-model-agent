/**
 * Модуль `Agent Service API v1`: сборка состояния + старт HTTP-сервера.
 * Публичный контракт отделён от `webui`; внутренности (`RunPool`,
 * `createSessionRunnerFactory`/`spawnSessionRunner`, `Agent`) переиспользуются.
 */
import { createServiceState, type AgentServiceState, type ServiceDeps } from "./state";
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
  const url = startServiceServer(state);
  state.starting = url;
  return { state, url, stop: () => stopServiceServer(state) };
}

export type { AgentServiceState, ServiceDeps } from "./state";
