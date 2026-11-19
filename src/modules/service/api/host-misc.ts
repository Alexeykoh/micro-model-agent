/**
 * `/v1/host/setup`, `/v1/host/index` (split W4b-2c). LSP — `host-lsp.ts`
 * (split W11). Недоступный модуль — `503`, не пустой успешный ответ.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildSetupDisplay, securityDetailFromConfig } from "../../setup/answers";
import { sendJson } from "../http/respond";
import type { AgentServiceState } from "../state";

/** `/v1/host/setup`; `true` — запрос обработан. */
export function handleHostSetup(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  parts: string[],
): boolean {
  if (parts.length !== 3 || parts[2] !== "setup" || req.method !== "GET") return false;
  const display = buildSetupDisplay();
  sendJson(res, 200, {
    required: false,
    languages: display.languages,
    providers: display.providers,
    defaults: {
      ...display.defaults,
      ...(s.config.security ? { security: securityDetailFromConfig(s.config.security) } : {}),
    },
  });
  return true;
}

/** `/v1/host/index` (POST); `true` — запрос обработан. */
export function handleHostIndex(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  parts: string[],
): boolean {
  if (parts.length !== 3 || parts[2] !== "index" || req.method !== "POST") return false;
  const indexer = s.deps.indexer;
  if (!indexer?.refresh) {
    sendJson(res, 503, { error: "unavailable" });
    return true;
  }
  void indexer.refresh().catch(() => {});
  sendJson(res, 202, { ok: true });
  return true;
}
