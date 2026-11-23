/**
 * Host-wire поверх job API (split W2): `/v1/host/*`.
 *
 * Это не второй путь исполнения хода: submit — тот же `dispatchInteractive`,
 * что `POST /v1/sessions/:id/tasks` с `mode: interactive`; поток событий — тот
 * же `openSessionStream`. Действия сессии вынесены в `host-session-routes.ts`,
 * read-панели — в `host-*` файлы (правило ≤300).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readMmaVersion } from "../../../core/version";
import { configVersion } from "../../../config/persist";
import { serializeConfigForWire } from "../../../config/redact";
import { buildConfigRegistry } from "../../../runtime/config-view";
import { applyConfigWrite, toConfigRaw } from "../../../runtime/config-write";
import { setLocale } from "../../../i18n/index";
import { PROTOCOL_VERSION } from "../../daemon/protocol";
import { readJsonBodyOrProblem, sendJson, sendProblem } from "../http/respond";
import { problem } from "../runtime/problem";
import { hostStateOf } from "../runtime/host-state";
import { hostCommandCatalog } from "../runtime/commands";
import type { AgentServiceState } from "../state";
import { handleHostFile } from "./host-file";
import { handleHostFiles } from "./host-files";
import { handleHostGit } from "./host-git";
import { handleHostIndex, handleHostSetup } from "./host-misc";
import { handleHostLspRoute } from "./host-lsp";
import { handleHostSetupWrite } from "./host-setup-write";
import { handleHostMcp } from "./host-mcp";
import { handleHostPlugins } from "./host-plugins";
import { handleHostProviders } from "./host-providers";
import { handleHostSearch } from "./host-search";
import { handleHostSessionAction } from "./host-session-routes";
import { handleHostSessions } from "./host-sessions";
import { handleHostMemory, handleHostSkills } from "./host-settings";
import { handleHostUpdate } from "./host-update";
import { MAX_JSON_BYTES } from "./tasks-job";

/** Обработчик группы `/v1/host[...]`; `true` — запрос обработан. */
export async function handleHostApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
): Promise<boolean> {
  const parts = reqUrl.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1" || parts[1] !== "host") return false;

  if (parts.length === 3 && parts[2] === "state" && req.method === "GET") {
    return stateRoute(res, s, reqUrl);
  }
  if (parts.length === 3 && parts[2] === "config" && req.method === "GET") {
    sendJson(res, 200, {
      config: serializeConfigForWire(s.config),
      registry: buildConfigRegistry(s.config),
      version: configVersion(s.config),
    });
    return true;
  }
  if (parts.length === 3 && parts[2] === "config" && req.method === "POST") {
    return writeConfig(req, res, s);
  }
  if (parts.length === 3 && parts[2] === "models" && req.method === "GET") {
    const provider = reqUrl.searchParams.get("provider") ?? undefined;
    const refresh = reqUrl.searchParams.get("refresh") === "1" && !provider;
    // Явное нажатие: дожидаемся провайдера и отдаём свежий список, иначе
    // daemon-адаптер не сможет обновить браузер по SSE `models`.
    if (refresh) await s.models.refresh();
    const resolved = provider
      ? s.models.getFor(provider)
      : { models: s.models.get(), loading: false, refreshStarted: refresh };
    sendJson(res, 200, resolved);
    return true;
  }
  if (parts.length === 3 && parts[2] === "commands" && req.method === "GET") {
    sendJson(res, 200, { commands: hostCommandCatalog() });
    return true;
  }
  if (parts[2] === "files") return handleHostFiles(req, res, reqUrl, s, parts);
  if (parts[2] === "file") return handleHostFile(req, res, reqUrl, s, parts);
  if (parts[2] === "search") return handleHostSearch(req, res, reqUrl, s, parts);
  if (parts[2] === "git") return handleHostGit(req, res, reqUrl, s, parts);
  if (parts[2] === "memory") return handleHostMemory(req, res, s, parts);
  if (parts[2] === "skills") return handleHostSkills(req, res, s, parts);
  if (parts[2] === "setup") {
    return req.method === "POST"
      ? handleHostSetupWrite(req, res, s, parts)
      : handleHostSetup(req, res, s, parts);
  }
  if (parts[2] === "index") return handleHostIndex(req, res, s, parts);
  if (parts[2] === "lsp") return handleHostLspRoute(req, res, s, parts);
  if (parts[2] === "plugins" || (parts[2] === "reload" && parts[3] === "plugins")) {
    return handleHostPlugins(req, res, s, parts);
  }
  if (parts[2] === "mcp") return handleHostMcp(req, res, s, parts);
  if (parts[2] === "providers") return handleHostProviders(req, res, s, parts);
  if (parts[2] === "update") return handleHostUpdate(req, res, s, parts);
  if (parts[2] !== "sessions") return false;
  if (
    parts.length === 3 ||
    (parts.length === 4 && req.method === "DELETE") ||
    (parts.length === 5 && (parts[4] === "history" || parts[4] === "log"))
  ) {
    return handleHostSessions(req, res, reqUrl, s, parts);
  }
  return handleHostSessionAction(req, res, reqUrl, s, parts);
}

/** `GET /v1/host/state?session=` — снапшот + workspace/protocol. */
function stateRoute(res: ServerResponse, s: AgentServiceState, reqUrl: URL): boolean {
  const sessionId = reqUrl.searchParams.get("session") ?? undefined;
  sendJson(res, 200, {
    state: hostStateOf(s, sessionId),
    workspace: s.deps.baseDir ?? process.cwd(),
    version: readMmaVersion(),
    protocol: PROTOCOL_VERSION,
  });
  return true;
}

/** `POST /v1/host/config {key, value}` — валидация, персист, reconfigure. */
async function writeConfig(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
): Promise<boolean> {
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const key = typeof body.key === "string" ? body.key : "";
  const raw = toConfigRaw(body.value);
  if (!key || raw === null) {
    sendProblem(res, problem({ type: "validation", title: "invalid-value", status: 400 }));
    return true;
  }
  // Reconfigure живого раннера опасен; тема — исключение (INV-T3).
  if (s.pool.anyBusy() && key !== "ui.theme" && key !== "ui.themeMode") {
    sendProblem(res, problem({ type: "validation", title: "busy", status: 409 }));
    return true;
  }
  const result = await applyConfigWrite(s.config, key, raw, {
    saveConfig: s.deps.saveConfig,
    reconfigure: s.deps.reconfigure,
  });
  if (!result.ok) {
    sendProblem(
      res,
      problem({ type: "validation", title: "invalid-value", status: 400, detail: result.error }),
    );
    return true;
  }
  if (key === "locale") setLocale(s.config.locale);
  if (key === "model" || key === "provider.active") void s.models.refresh();
  sendJson(res, 200, result);
  return true;
}
