// HTTP + SSE + REST транспорт `mma web` (app-слой отделён от listen ради тестов).
/**
 * `handleRequest` — чистый app-слой на явном `WebUiState`, чтобы тесты гоняли
 * его герметично (правило #13: создание app отдельно от `listen()`).
 * `startServer`/`stopServer` по умолчанию — ленивое процесс-глобальное состояние
 * для CLI. Транспортные хелперы — в `./util`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createWebUiState } from "./state";
import { sessionStatus } from "./session-status";
import {
  checkAuth,
  isLoopback,
  sameOrigin,
  sendJson,
  setAuthCookie,
} from "./util";
import { handleMessagePost } from "./turns";
import { handleCommandPost, handleInterruptPost, handleIndexPost } from "./actions-api";
import { handleConfigGet, handleConfigPost, handleModelsGet } from "./config-api";
import { handleI18nGet } from "./i18n-api";
import { webCommandList } from "./commands";
import { handleAnswerPost } from "./answer-api";
import { handleSessionsApi } from "./sessions-api";
import { handleLspGet, handleMcpCreate, handleSettingsApi } from "./settings-api";
import { handleProvidersApi } from "./providers-api";
import { handleFileApi } from "./file-api";
import { handleSetupApi } from "./setup-api";
import { handleLspDoctorGet, handleLspDoctorPost } from "./lsp-api";
import type { WebUiState, WebUiAssets } from "./state";
import { readEnv } from "../../config/env";

/** Реэкспорт открытия браузера для CLI. */
export { tryOpenBrowser } from "./util";

/** Статические роуты, отдаваемые как есть (без шаблонной обработки). */
const STATIC_ASSETS: Record<string, { type: string; key: keyof WebUiAssets }> = {
  "/index.html": { type: "text/html; charset=utf-8", key: "html" },
  "/styles.css": { type: "text/css; charset=utf-8", key: "css" },
  "/app.js": { type: "text/javascript; charset=utf-8", key: "js" },
  "/setup.js": { type: "text/javascript; charset=utf-8", key: "setupJs" },
  "/md.js": { type: "text/javascript; charset=utf-8", key: "mdJs" },
  "/smd.js": { type: "text/javascript; charset=utf-8", key: "smdJs" },
  "/hljs.js": { type: "text/javascript; charset=utf-8", key: "hljsJs" },
};

/**
 * SSE-хендлер: поток `/events` с капом клиентов и heartbeat.
 *
 * Backpressure: `res.write() === false` — буфер сокета полон (медленный/виснущий
 * читатель). Дропаем клиента сразу, а не копим события безгранично — живой вид
 * не стоит OOM.
 */
function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  s: WebUiState,
  sessionId?: string,
): void {
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
  if (sessionId) s.clientSessions.set(res, sessionId);
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
    s.clientSessions.delete(res);
  };
  req.on("close", close);
  res.on("close", close);
}

/** Убирает медленного/битого SSE-клиента и закрывает его ответ. */
function dropClient(res: ServerResponse, s: WebUiState): void {
  s.clients.delete(res);
  s.clientSessions.delete(res);
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
  "POST /api/mcp": (req, res, s) => handleMcpCreate(req, res, s),
  "GET /api/lsp": (_req, res, s) => handleLspGet(res, s),
  "GET /api/lsp/doctor": (_req, res, s) => handleLspDoctorGet(res, s),
  "POST /api/lsp/doctor": (_req, res, s) => handleLspDoctorPost(res, s),
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
) => boolean> = [handleSetupApi, handleSessionsApi, handleSettingsApi, handleProvidersApi, handleFileApi];

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

/** `POST /api/command|interrupt|index` — действия, вывод стримится по SSE (см. `./actions-api`). */

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

  if (reqUrl.pathname === "/events") {
    // Auth и на SSE-поток: не-loopback бинд с токеном не должен светить события.
    // `?token=` принимаем, т.к. EventSource заголовки ставить не умеет.
    if (!checkAuth(req, reqUrl, s)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    setAuthCookie(res, s);
    handleEvents(req, res, s, reqUrl.searchParams.get("session") ?? undefined);
    return;
  }

  const asset = STATIC_ASSETS[reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname];
  if (asset) {
    // Перечитываем с диска, когда можно, чтобы правки ассетов цеплялись без
    // рестарта; `no-store` не даёт браузеру кешировать протухший UI. Фиксированный
    // снапшот из `startServer` — фолбэк (тесты, ошибки чтения).
    const src = s.assetSource ? s.assetSource() : assets;
    res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-store" });
    res.end(src[asset.key] ?? assets[asset.key] ?? "");
    return;
  }

  // Разделённые фронтенд-модули (`/js/*.js`, относительные ESM-импорты из `/app.js`).
  // Та же live-reload семантика, что у статики выше.
  if (reqUrl.pathname.startsWith("/js/") && reqUrl.pathname.endsWith(".js")) {
    const key = reqUrl.pathname.slice(1);
    const src = s.assetSource ? s.assetSource() : assets;
    const body = src.jsModules?.[key] ?? assets.jsModules?.[key];
    if (body !== undefined) {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
      return;
    }
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
    handleApi(req, res, reqUrl, s);
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
  s.lastPostTs = 0;
}
