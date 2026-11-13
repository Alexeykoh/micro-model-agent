/**
 * `/v1/host/setup`, `/v1/host/index`, `/v1/host/lsp*` (split W4b-2c).
 *
 * Setup — статические display-данные; index — пересборка карты проекта;
 * LSP — флаги и диагностика workspace. Недоступный модуль — `503`, не пустой
 * успешный ответ.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildSetupDisplay, securityDetailFromConfig } from "../../../modules/setup/answers";
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

/** `/v1/host/lsp` и `/v1/host/lsp/doctor`; `true` — запрос обработан. */
export function handleHostLsp(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  parts: string[],
): boolean {
  if (parts[2] !== "lsp" || req.method !== "GET") return false;
  const lsp = s.deps.lsp;
  if (!lsp) {
    sendJson(res, 503, { error: "lsp_unavailable" });
    return true;
  }
  if (parts.length === 3) {
    sendJson(res, 200, lsp.getFlags?.() ?? { enabled: true, offline: false });
    return true;
  }
  if (parts.length === 4 && parts[3] === "doctor") {
    void diagnose(res, lsp, s.deps.baseDir ?? process.cwd());
    return true;
  }
  return false;
}

async function diagnose(
  res: ServerResponse,
  lsp: NonNullable<AgentServiceState["deps"]["lsp"]>,
  base: string,
): Promise<void> {
  try {
    sendJson(res, 200, await lsp.diagnose(base));
  } catch (err) {
    sendJson(res, 500, {
      error: "lsp_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
