/**
 * LSP через host wire (split W11): таблица серверов, правка, проверка файла,
 * диагностика и кэш последнего результата.
 *
 * Формы ответов совпадают с web-панелью (`servers`, `diagnosis/probing/flags`),
 * поэтому адаптер отдаёт их без пересборки.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { listLspServers, updateLspServer } from "../../../runtime/lsp-settings";
import { readJsonBodyOrProblem, sendJson } from "../http/respond";
import { emitAllSessions } from "../runtime/emit";
import type { AgentServiceState } from "../state";

const MAX_JSON_BYTES = 1024 * 1024;


/** Обрабатывает `/v1/host/lsp*`; `true` — запрос обработан. */
export async function handleHostLspRoute(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  parts: string[],
): Promise<boolean> {
  if (parts[2] !== "lsp") return false;
  const lsp = s.deps.lsp;
  const action = parts[3];

  if (parts.length === 3 && req.method === "GET") {
    sendJson(res, 200, { servers: listLspServers(s.config) });
    return true;
  }
  if (parts.length === 4 && action === "doctor" && req.method === "GET") {
    sendJson(res, 200, {
      diagnosis: s.lspDoctor ?? null,
      probing: s.lspProbing,
      ...(lsp?.getFlags ? { flags: lsp.getFlags() } : {}),
    });
    return true;
  }
  if (parts.length === 4 && action === "doctor" && req.method === "POST") {
    return doctor(s, res, lsp);
  }
  if (parts.length === 4 && action === "check" && req.method === "POST") {
    return check(req, res, s, lsp);
  }
  if (parts.length === 4 && action === "check-changed" && req.method === "POST") {
    return checkChanged(res, s, lsp);
  }
  if (parts.length === 4 && req.method === "PUT") {
    return update(req, res, s, decodeURIComponent(action));
  }
  return false;
}

/** GET-таблица уже отдана; правка одного сервера + persist. */
async function update(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  lang: string,
): Promise<boolean> {
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const result = updateLspServer(s.config, lang, body);
  if (!result.ok) {
    sendJson(res, result.error === "not_found" ? 404 : 400, {
      ok: false,
      error: result.error,
    });
    return true;
  }
  let persisted = true;
  try {
    s.deps.saveConfig?.(s.config, "lsp");
  } catch {
    persisted = false;
  }
  sendJson(res, 200, {
    ok: true,
    persisted,
    restartRequired: true,
    servers: listLspServers(s.config),
  });
  return true;
}

/** POST …/lsp/doctor — single-flight, результат приходит SSE `lsp`. */
function doctor(
  s: AgentServiceState,
  res: ServerResponse,
  lsp: AgentServiceState["deps"]["lsp"],
): boolean {
  if (!lsp?.diagnose) {
    sendJson(res, 503, { ok: false, error: "unavailable" });
    return true;
  }
  if (s.lspProbing) {
    sendJson(res, 202, { ok: true, probing: true });
    return true;
  }
  s.lspProbing = true;
  emitAllSessions(s, "lsp", { phase: "start" });
  Promise.resolve(lsp.diagnose(s.deps.baseDir ?? process.cwd()))
    .then((diagnosis) => {
      s.lspDoctor = diagnosis;
      emitAllSessions(s, "lsp", { phase: "done" });
    })
    .catch(() => emitAllSessions(s, "lsp", { phase: "error" }))
    .finally(() => {
      s.lspProbing = false;
    });
  sendJson(res, 202, { ok: true });
  return true;
}

/** POST …/lsp/check — диагностика одного файла; отказы данными, не 500. */
async function check(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  lsp: AgentServiceState["deps"]["lsp"],
): Promise<boolean> {
  if (!lsp?.checkFileForWeb) {
    sendJson(res, 503, { ok: false, error: "unavailable" });
    return true;
  }
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const path = typeof body.path === "string" ? body.path : "";
  const result = await lsp.checkFileForWeb(path, s.deps.baseDir ?? process.cwd());
  if (!result) {
    sendJson(res, 503, { ok: false, error: "unavailable" });
    return true;
  }
  const status = result.ok
    ? 200
    : result.error === "outside-workspace" || result.error === "not-found"
      ? 400
      : result.error === "starting"
        ? 200
        : 503;
  sendJson(res, status, result);
  return true;
}

/** POST …/lsp/check-changed — диагностика изменённых файлов рабочего дерева. */
async function checkChanged(
  res: ServerResponse,
  s: AgentServiceState,
  lsp: AgentServiceState["deps"]["lsp"],
): Promise<boolean> {
  if (!lsp?.checkChangedForWeb) {
    sendJson(res, 503, { ok: false, error: "unavailable" });
    return true;
  }
  const result = await lsp.checkChangedForWeb(s.deps.baseDir ?? process.cwd());
  if (!result) {
    sendJson(res, 503, { ok: false, error: "unavailable" });
    return true;
  }
  sendJson(res, 200, result);
  return true;
}
