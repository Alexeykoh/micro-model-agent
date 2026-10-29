// HTTP + SSE + REST транспорт `mma web` (app-слой отделён от listen ради тестов).
/**
 * `handleRequest` — чистый app-слой на явном `WebUiState`, чтобы тесты гоняли
 * его герметично (правило #13: создание app отдельно от `listen()`).
 * `startServer`/`stopServer` по умолчанию — ленивое процесс-глобальное состояние
 * для CLI. Транспортные хелперы — в `./util`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createWebUiState, type WebUiState, type WebUiAssets } from "./state";
import { sessionStatus } from "./session/session-status";
import {
  checkAuth,
  isLoopback,
  sameOrigin,
  sendJson,
  setAuthCookie,
  SECURITY_HEADERS,
} from "./util";
import { handleMessagePost } from "./session/turns";
import { handleQueueCancel, handleQueueStart } from "./session/queue-api";
import { handleCommandPost, handleInterruptPost, handleIndexPost } from "./chat/actions-api";
import { handleConfigGet, handleConfigPost, handleModelsGet } from "./settings/config-api";
import { handleI18nGet } from "./i18n/i18n-api";
import { webCommandList } from "./chat/commands";
import { handleAnswerPost } from "./session/answer-api";
import { handleSessionsApi } from "./session/sessions-api";
import { handleLspGet, handleMcpCreate, handleSettingsApi } from "./settings/settings-api";
import { handleMcpList } from "./settings/mcp-list";
import { handleProvidersApi } from "./settings/providers-api";
import { handleFileApi } from "./file/file-api";
import { handleFilesApi } from "./file/files-api";
import { handleSetupApi } from "./settings/setup-api";
import { handleLspDoctorGet, handleLspCheckPost, handleLspCheckChangedPost, handleLspDoctorPost } from "./lsp/lsp-api";
import { readJsonBody } from "./http/body";
import { handleUpdatePost } from "./chat/update-api";
import { apiGuardFor, filterResponse } from "./egress";
import { serveStatic } from "./static-assets";
import { handleFaviconGet } from "./favicon";
import { readEnv } from "../../config/env";
export { tryOpenBrowser } from "./util"; // реэкспорт для CLI

/** Статические роуты, отдаваемые как есть (без шаблонной обработки). */
/**
 * SSE-хендлер: поток `/events` с капом клиентов и heartbeat.
 *
 * Backpressure: `res.write() === false` — буфер сокета полон (медленный/виснущий
 * читатель). Дропаем клиента сразу, а не копим события безгранично — живой вид
 * не стоит OOM.
 */
function handleEvents(req: IncomingMessage, res: ServerResponse, s: WebUiState): void {
  if (s.clients.size >= s.maxClients) {
    sendJson(res, 503, { error: "too many clients" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const greeted =
    res.write("retry: 1200\n\n") &&
    res.write(`event: state\ndata: ${JSON.stringify({ ts: Date.now(), ...sessionStatus(s) })}\n\n`);
  if (!greeted) {
    res.end();
    return;
  }
  s.clients.add(res);
  const hb = setInterval(() => {
    try {
      if (!res.write(`: hb ${Date.now()}\n\n`)) dropClient(res, s);
    } catch {
      dropClient(res, s); // клиент отвалился — heartbeat больше не нужен
    }
  }, 15_000);
  const close = (): void => {
    clearInterval(hb);
    s.clients.delete(res);
  };
  req.on("close", close);
  res.on("close", close);
}

/** Убирает медленного/битого SSE-клиента и закрывает его ответ. */
function dropClient(res: ServerResponse, s: WebUiState): void {
  s.clients.delete(res);
  try {
    res.end();
  } catch {
    /* уже ушёл */
  }
}

/** Точные роуты `METHOD путь` (правило #17: карта хендлеров, без `if`). */
const API_ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse, s: WebUiState) => void> = {
  "GET /api/state": (req, res, s) => {
    // `?session=<id>` — сайдбар вкладки строится от ЕЁ сессии, не от
    // серверно-активной (иначе переключение вкладок показывает чужие данные).
    let sessionId: string | undefined;
    try {
      const sid = new URL(req.url ?? "/", "http://localhost").searchParams.get("session");
      if (sid) sessionId = sid;
    } catch {
      /* битый URL — активная сессия */
    }
    sendJson(res, 200, {
      ...sessionStatus(s),
      state: s.bridge?.getState?.(sessionId) ?? null,
    });
  },
  "POST /api/message": (req, res, s) => handleMessagePost(req, res, s),
  "POST /api/queue/cancel": (req, res, s) => handleQueueCancel(req, res, s),
  "POST /api/queue/start": (req, res, s) => handleQueueStart(req, res, s),
  "GET /api/config": (_req, res, s) => handleConfigGet(res, s),
  "POST /api/config": (req, res, s) => handleConfigPost(req, res, s),
  "POST /api/answer": (req, res, s) => handleAnswerPost(req, res, s),
  "GET /api/i18n": (_req, res, s) => handleI18nGet(res, s),
  "GET /api/commands": (_req, res) => {
    sendJson(res, 200, { commands: webCommandList() });
  },
  "GET /api/models": (_req, res, s) => handleModelsGet(res, s),
  "POST /api/command": (req, res, s) => handleCommandPost(req, res, s),
  "POST /api/interrupt": (req, res, s) => handleInterruptPost(req, res, s),
  "POST /api/index": (_req, res, s) => handleIndexPost(res, s),
  "POST /api/update": (_req, res, s) => handleUpdatePost(res, s),
  "POST /api/mcp": (req, res, s) => handleMcpCreate(req, res, s),
  "GET /api/mcp": (_req, res, s) => handleMcpList(res, s),
  "GET /api/favicon": (_req, res, s) => handleFaviconGet(res, s),
  "GET /api/lsp": (_req, res, s) => handleLspGet(res, s),
  "GET /api/lsp/doctor": (_req, res, s) => handleLspDoctorGet(res, s),
  "POST /api/lsp/doctor": (_req, res, s) => handleLspDoctorPost(res, s),
  "POST /api/lsp/check": (req, res, s) =>
    readJsonBody(req, s.maxBodyBytes).then((body) => handleLspCheckPost(body, res, s)),
  "POST /api/lsp/check-changed": (_req, res, s) => handleLspCheckChangedPost(res, s),
};

/**
 * Префикс-группы диспатча (sessions/settings/providers/file/setup владеют
 * своими под-путями). После точной таблицы; каждая сообщает, обработала ли.
 */
const API_GROUPS: Array<(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: WebUiState,
) => boolean> = [handleSetupApi, handleSessionsApi, handleSettingsApi, handleProvidersApi, handleFileApi, handleFilesApi];

/** REST-хендлер `/api/*`; auth + same-origin уже проверены. */
function handleApi(req: IncomingMessage, res: ServerResponse, reqUrl: URL, s: WebUiState): void {
  const route = API_ROUTES[`${req.method} ${reqUrl.pathname}`];
  if (route) {
    route(req, res, s);
    return;
  }
  for (const group of API_GROUPS) {
    if (group(req, res, reqUrl, s)) return;
  }
  sendJson(res, 404, { error: "not found" });
}

/**
 * Точка входа запросов: SSE, статика, `/js`-модули, `/api/*`, иначе 404.
 * Auth обязателен и для SSE-потока, и для API; same-origin — для пишущих.
 */
export function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  assets: WebUiAssets,
  s: WebUiState,
): void {
  let reqUrl: URL;
  try {
    reqUrl = new URL(req.url || "/", `http://${req.headers.host || s.host}`);
  } catch {
    // Битый/враждебный `Host` (или URL абсолютной формы): не роняем листенер —
    // отвергаем запрос.
    sendJson(res, 400, { error: "bad request" });
    return;
  }

  // Security-заголовки на всех ответах (CSP, фрейминг, MIME, referrer).
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }

  if (reqUrl.pathname === "/events") {
    // Auth и на SSE-поток: не-loopback бинд с токеном не должен светить события.
    // `?token=` принимаем, т.к. EventSource заголовки ставить не умеет.
    if (!checkAuth(req, reqUrl, s)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    setAuthCookie(res, s);
    handleEvents(req, filterResponse(res, apiGuardFor(s, req.socket.remoteAddress), "sse"), s);
    return;
  }

  // Статика (документ, стили, скрипты) — под auth и с security-заголовками.
  if (serveStatic(req, res, reqUrl, assets, s)) {
    return;
  }

  if (reqUrl.pathname.startsWith("/api/")) {
    if (!checkAuth(req, reqUrl, s)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (!sameOrigin(req, reqUrl)) {
      sendJson(res, 403, { error: "cross-origin requests are not allowed" });
      return;
    }
    setAuthCookie(res, s);
    handleApi(req, filterResponse(res, apiGuardFor(s, req.socket.remoteAddress), "json"), reqUrl, s);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

let defaultState: WebUiState | null = null;

/** Ленивое процесс-глобальное состояние для вызовов без явного. */
function getDefaultState(): WebUiState {
  if (!defaultState) defaultState = createWebUiState();
  return defaultState;
}

/**
 * Стартует HTTP-сервер на хосте/порту состояния (порт — env `MMA_WEBUI_PORT`).
 * Не-loopback без токена — отказ. Резолвится публичным URL.
 */
export function startServer(
  assets: WebUiAssets,
  s: WebUiState = getDefaultState(),
): Promise<string> {
  if (s.server) return Promise.resolve(s.url);
  if (s.starting) return s.starting;
  if (!isLoopback(s.host) && !s.token) {
    return Promise.reject(new Error(`refusing to bind ${s.host} without a token (non-loopback)`));
  }
  const desired = Number(readEnv("WEBUI_PORT")) || 0;
  s.starting = new Promise<string>((resolve, reject) => {
    const srv = createServer((req, res) => handleRequest(req, res, assets, s));
    srv.on("error", (err) => {
      s.starting = null;
      reject(err);
    });
    srv.listen(desired, s.host, () => {
      s.server = srv;
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : desired;
      s.url = `http://${s.host}:${port}`;
      s.starting = null;
      resolve(s.url);
    });
  });
  return s.starting;
}

/** Останавливает сервер: дроп клиентов, закрытие, сброс busy-флагов. */
export function stopServer(s: WebUiState = getDefaultState()): void {
  for (const client of s.clients) {
    try {
      client.end();
    } catch {
      /* best-effort чистка */
    }
  }
  s.clients.clear();
  if (s.server) {
    try {
      s.server.close();
    } catch {
      /* best-effort чистка */
    }
    s.server = null;
  }
  s.starting = null;
  s.busy = false;
  s.agentRunning = false;
  s.pool.clear();
  s.lastPostTs.clear();
}
