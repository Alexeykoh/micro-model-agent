/**
 * Host-wire поверх job API (split W2): `/v1/host/*`.
 *
 * Это не второй путь исполнения хода: submit — тот же `dispatchInteractive`,
 * что `POST /v1/sessions/:id/tasks` с `mode: interactive`; поток событий —
 * тот же `openSessionStream`. Отличие только в форме запроса/ответа.
 *
 * `executeCommand` в W2 не реализован: хендлеры команд живут в CLI и требуют
 * `CommandServices` (перенос — W3). Роут не объявлен, клиент получает 404.
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
import { resolveAnswer } from "../runtime/prompt-io";
import { problem } from "../runtime/problem";
import { hostStateOf } from "../runtime/host-state";
import { runHostCommand } from "../runtime/commands";
import type { AgentServiceState } from "../state";
import { openSessionStream } from "./events-api";
import { handleHostSessions } from "./host-sessions";
import { handleHostFiles } from "./host-files";
import { handleHostGit } from "./host-git";
import { interruptSession } from "./tasks-control";
import { MAX_JSON_BYTES, tenantOf } from "./tasks-job";
import { dispatchInteractive } from "./tasks-submit";

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
    const resolved = provider
      ? s.models.getFor(provider)
      : { models: s.models.get(), loading: false };
    sendJson(res, 200, resolved);
    return true;
  }
  if (parts[2] === "files") return handleHostFiles(req, res, reqUrl, s, parts);
  if (parts[2] === "git") return handleHostGit(req, res, reqUrl, s, parts);
  if (parts[2] !== "sessions") return false;
  if (
    parts.length === 3 ||
    (parts.length === 4 && req.method === "DELETE") ||
    (parts.length === 5 && (parts[4] === "history" || parts[4] === "log"))
  ) {
    return handleHostSessions(req, res, reqUrl, s, parts);
  }
  if (parts.length !== 5) return false;

  const sessionId = decodeURIComponent(parts[3]);
  const action = parts[4];
  if (!ensureSession(s, res, sessionId)) return true;

  if (action === "submit" && req.method === "POST") return submit(req, res, s, sessionId);
  if (action === "stream" && req.method === "GET") {
    openSessionStream(req, res, reqUrl, s, sessionId);
    return true;
  }
  if (action === "interrupt" && req.method === "POST") {
    sendJson(res, 202, { sessionId, interrupted: interruptSession(s, sessionId) });
    return true;
  }
  if ((action === "pause" || action === "resume") && req.method === "POST") {
    return setPaused(res, s, sessionId, action === "pause");
  }
  if (action === "answer" && req.method === "POST") return answer(req, res, s, sessionId);
  if (action === "command" && req.method === "POST") return command(req, res, s, sessionId);
  return false;
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

/** Максимум картинок и размер одного data-URL (как у web). */
const MAX_IMAGES = 10;
const MAX_IMAGE_DATA_URL_BYTES = 70 * 1024 * 1024;

/** Проверка `images`: только `data:image/...`, не больше 10 и 70 МБ каждая. */
function parseImages(
  raw: unknown,
): { ok: true; images: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "images must be an array" };
  if (raw.length > MAX_IMAGES) return { ok: false, error: "too many images" };
  const images: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.startsWith("data:image/")) {
      return { ok: false, error: "invalid image" };
    }
    if (Buffer.byteLength(item, "utf8") > MAX_IMAGE_DATA_URL_BYTES) {
      return { ok: false, error: "image too large" };
    }
    images.push(item);
  }
  return { ok: true, images };
}

/** `POST /v1/host/sessions/:id/submit {text}` — интерактивный ход. */
async function submit(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  sessionId: string,
): Promise<boolean> {
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    sendProblem(res, problem({ type: "validation", title: "text required", status: 400 }));
    return true;
  }
  const parsed = parseImages(body.images);
  if (!parsed.ok) {
    sendProblem(res, problem({ type: "validation", title: parsed.error, status: 422 }));
    return true;
  }
  const created = dispatchInteractive(s, sessionId, text, tenantOf(req, s), parsed.images);
  if (!created.ok) {
    sendProblem(
      res,
      problem({
        type: "queueFull",
        title: "session queue is full",
        status: 429,
        retriable: true,
        retryAfterMs: 1000,
      }),
    );
    return true;
  }
  res.setHeader("Location", `/v1/tasks/${created.task.jobId}`);
  sendJson(res, 202, {
    sessionId,
    turnId: created.task.jobId,
    jobId: created.task.jobId,
    status: created.task.status,
  });
  return true;
}

/** Пауза/резюме хода: durable-флаг на агенте уже поднятого раннера. */
function setPaused(
  res: ServerResponse,
  s: AgentServiceState,
  sessionId: string,
  paused: boolean,
): boolean {
  const agent = s.pool.getRunner(sessionId)?.agent as
    { pause?: () => void; resume?: () => void } | undefined;
  if (!agent || typeof agent.pause !== "function" || typeof agent.resume !== "function") {
    sendProblem(
      res,
      problem({
        type: "validation",
        title: "no active runner for session",
        status: 409,
        detail: sessionId,
      }),
    );
    return true;
  }
  if (paused) agent.pause();
  else agent.resume();
  sendJson(res, 202, { sessionId, paused });
  return true;
}

/** `POST /v1/host/sessions/:id/answer {id, answer}` — ответ на вопрос хода. */
async function answer(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  sessionId: string,
): Promise<boolean> {
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    sendProblem(res, problem({ type: "validation", title: "question id required", status: 400 }));
    return true;
  }
  if (!resolveAnswer(s, id, body.answer, { sessionId })) {
    sendProblem(
      res,
      problem({ type: "validation", title: "unknown question id", status: 404, detail: id }),
    );
    return true;
  }
  sendJson(res, 202, { sessionId, status: "running" });
  return true;
}

/** `POST /v1/host/sessions/:id/command {line}` — серверное подмножество. */
async function command(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  sessionId: string,
): Promise<boolean> {
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const line = typeof body.line === "string" ? body.line : "";
  if (!line.trim()) {
    sendProblem(res, problem({ type: "validation", title: "line required", status: 400 }));
    return true;
  }
  sendJson(res, 200, await runHostCommand(s, sessionId, line));
  return true;
}

/** Сессия обязана существовать; иначе 503/404 и `false`. */
function ensureSession(s: AgentServiceState, res: ServerResponse, sessionId: string): boolean {
  const manager = s.deps.sessionManager;
  if (!manager) {
    sendProblem(res, problem({ type: "internal", title: "sessions unavailable", status: 503 }));
    return false;
  }
  if (!manager.get(sessionId)) {
    sendProblem(
      res,
      problem({ type: "noSession", title: "session not found", status: 404, detail: sessionId }),
    );
    return false;
  }
  return true;
}
