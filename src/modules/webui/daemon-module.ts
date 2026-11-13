/**
 * `mma web --daemon <url>`: браузерный UI без собственного рантайма (split W4).
 *
 * Состояние, ходы, сессии и конфиг живут в демоне; здесь — статика, auth,
 * проксирование `/api/*` и перенос событий демона в веб-SSE.
 */
import { createAssetSource } from "./asset-cache";
import { startServer, stopServer } from "./server";
import { broadcast, createWebUiState, type WebUiState } from "./state";
import { mapHostEvent } from "./daemon-events";
import type { WebDaemonHost } from "./daemon-contracts";

/** Опции daemon-режима web. */
export interface WebDaemonOptions {
  daemon: WebDaemonHost;
  host?: string;
  token?: string;
}

/** Хендл запущенного адаптера. */
export interface WebDaemonHandle {
  state: WebUiState;
  url: Promise<string>;
  stop(): void;
}

/** Поднимает web-адаптер над уже подключённым демоном. */
export async function startWebDaemon(opts: WebDaemonOptions): Promise<WebDaemonHandle> {
  const state = createWebUiState();
  state.daemon = opts.daemon;
  state.bridge = opts.daemon;
  if (opts.host) state.host = opts.host;
  if (opts.token) state.token = opts.token;

  await resolveSession(opts.daemon);
  const unsubscribe = opts.daemon.subscribeEvents((ev) => {
    const mapped = mapHostEvent(ev);
    if (mapped) broadcast(mapped, state);
    if (mapped?.type === "turn_end" || mapped?.type === "update") void pushState(state);
  });

  const assets = createAssetSource();
  const url = startServer(assets.get(), state);
  void url.then(() => pushState(state)).catch(() => {});
  return {
    state,
    url,
    stop: () => {
      unsubscribe();
      opts.daemon.dispose();
      stopServer(state);
    },
  };
}

/** Активная сессия демона; иначе первая из списка или новая. */
async function resolveSession(host: WebDaemonHost): Promise<string> {
  const state = await host.getState();
  if (state.sessionId) {
    host.setSessionId(state.sessionId);
    return state.sessionId;
  }
  const sessions = await host.listSessions();
  if (sessions[0]) {
    host.setSessionId(sessions[0].id);
    return sessions[0].id;
  }
  const created = await host.createSession("web");
  host.setSessionId(created.id);
  return created.id;
}

/** Снапшот в SSE после завершения хода (браузер не опрашивает `/api/state`). */
async function pushState(s: WebUiState & { daemon?: WebDaemonHost }): Promise<void> {
  try {
    const state = await s.daemon?.getState();
    if (state) broadcast({ type: "state", ts: Date.now(), state }, s);
  } catch {
    /* демон недоступен: следующий запрос честно ответит 502 */
  }
}
