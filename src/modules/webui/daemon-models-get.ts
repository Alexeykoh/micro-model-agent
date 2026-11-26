/**
 * `GET /api/models` в daemon-режиме: прокси в host wire + явный рефреш.
 * Вынесено из `daemon-api-routes.ts`, чтобы таблица маршрутов не росла.
 */
import type { ServerResponse } from "node:http";
import type { WebDaemonHost } from "./daemon-contracts";
import { broadcast, type SseTransport } from "./state";
import { sendJson } from "./util";

export async function daemonModelsGet(
  res: ServerResponse,
  reqUrl: URL,
  s: SseTransport,
  host: WebDaemonHost,
): Promise<void> {
  const q = reqUrl.searchParams;
  const models = await host.listModels(
    q.get("provider") ?? undefined,
    q.get("refresh") === "1",
  );
  // Демон уже дождался listModels(); рассылаем событие, чтобы браузер
  // перечитал свежий список так же, как в локальном режиме (SSE `models`).
  if (models.refreshStarted) broadcast({ type: "models", ts: Date.now() }, s);
  sendJson(res, 200, models);
}
