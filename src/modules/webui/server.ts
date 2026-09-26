/**
 * HTTP + SSE + REST transport for `mma web`.
 *
 * `handleRequest` is the pure app layer taking an explicit `WebUiState` so tests
 * drive it hermetically (rule #13: app creation separated from `listen()`).
 * `startServer`/`stopServer` default to a lazy process-global state for the CLI.
 * Transport helpers live in `./util`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createWebUiState } from "./state";
import {
  checkAuth,
  handleMessagePost,
  isLoopback,
  readBody,
  readBodyError,
  sameOrigin,
  sendJson,
  setAuthCookie,
} from "./util";
import { parseJsonBody } from "./body";
import { handleConfigGet, handleConfigPost, handleModelsGet } from "./config-api";
import { handleI18nGet } from "./i18n-api";
import { webCommandList } from "./commands";
import { handleAnswerPost } from "./answer-api";
import { handleSessionsApi } from "./sessions-api";
import { handleSettingsApi } from "./settings-api";
import { handleProvidersApi } from "./providers-api";
import { handleFileApi } from "./file-api";
import { handleSetupApi } from "./setup-api";
import type { WebUiState, WebUiAssets } from "./state";

export { tryOpenBrowser } from "./util";

/** Static routes served verbatim (never template-processed). */
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
 * SSE handler: `/events` stream with client cap + heartbeat.
 *
 * Backpressure: `res.write()` returning false means the socket buffer is full
 * (slow/stalled reader). We drop the client immediately instead of buffering
 * events unboundedly — a live view is not worth an OOM.
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
    res.write(`event: state\ndata: ${JSON.stringify({ busy: s.busy })}\n\n`);
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

/** Remove a slow/broken SSE client and end its response. */
function dropClient(res: ServerResponse, s: WebUiState): void {
  s.clients.delete(res);
  try {
    res.end();
  } catch {
    /* already gone */
  }
}

/** Exact `METHOD path` routes (rule #17: handler map, no `if` chain). */
const API_ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse, s: WebUiState) => void> = {
  "GET /api/state": (_req, res, s) => {
    sendJson(res, 200, { busy: s.busy, state: s.bridge?.getState?.() ?? null });
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
  "POST /api/interrupt": (_req, res, s) => handleInterruptPost(res, s),
};

/**
 * Prefix-group dispatchers (sessions/settings/providers/file/setup own their
 * sub-paths). Tried after the exact table; each reports whether it handled
 * the request.
 */
const API_GROUPS: Array<(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: WebUiState,
) => boolean> = [handleSetupApi, handleSessionsApi, handleSettingsApi, handleProvidersApi, handleFileApi];

/** REST handler for `/api/*`; assumes auth + same-origin already checked. */
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

/** `POST /api/command` — fire-and-forget dispatch, output streams over SSE. */
function handleCommandPost(req: IncomingMessage, res: ServerResponse, s: WebUiState): void {
  if (s.setupRequired) {
    sendJson(res, 409, { error: "setup_required" });
    return;
  }
  const bridge = s.bridge;
  readBody(req, s.maxBodyBytes)
    .then((raw) => {
      let line = "";
      // Malformed body: the dispatcher ignores a non-slash line, so this is
      // a harmless no-op rather than a 400.
      const rec = parseJsonBody(raw) ?? {};
      if (typeof rec.line === "string") line = rec.line;
      // A host error must never become a 5xx: the POST only acknowledges
      // acceptance, output streams over SSE as `command` events.
      Promise.resolve(bridge?.executeCommand(line)).catch(() => {});
      sendJson(res, 202, { ok: true });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/** `POST /api/interrupt` — abort the running turn without unlocking early. */
function handleInterruptPost(res: ServerResponse, s: WebUiState): void {
  if (!s.busy && !s.bridge?.isBusy()) {
    sendJson(res, 409, { error: "idle" });
    return;
  }
  // Do NOT clear `busy` here: the forwarder's `onTurnEnd` owns the reset for
  // any turn that actually started. Clearing now would unlock the UI while the
  // aborted turn is still unwinding and let a second submit slip in. If the
  // host is not actually running (reservation only), `interrupt()` is a no-op
  // and the pending submit path releases the slot.
  s.bridge?.interrupt();
  sendJson(res, 200, { ok: true });
}

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
    // Malformed / hostile `Host` (or absolute-form request URL): don't crash the
    // listener — reject the request.
    sendJson(res, 400, { error: "bad request" });
    return;
  }

  if (reqUrl.pathname === "/events") {
    // Auth applies to the SSE stream too: a non-loopback bind with a token must
    // not leak events. `?token=` is accepted because EventSource cannot set headers.
    if (!checkAuth(req, reqUrl, s)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    setAuthCookie(res, s);
    handleEvents(req, res, s);
    return;
  }

  const asset = STATIC_ASSETS[reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname];
  if (asset) {
    // Re-read from disk when possible so editing the assets is picked up without
    // a restart; `no-store` keeps the browser from caching a stale UI. The fixed
    // snapshot passed to `startServer` is the fallback (tests, read failures).
    const src = s.assetSource ? s.assetSource() : assets;
    res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-store" });
    res.end(src[asset.key] ?? assets[asset.key] ?? "");
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
    handleApi(req, res, reqUrl, s);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

let defaultState: WebUiState | null = null;

/** Lazily created process-global state used when callers pass no explicit one. */
function getDefaultState(): WebUiState {
  if (!defaultState) defaultState = createWebUiState();
  return defaultState;
}

export function startServer(
  assets: WebUiAssets,
  s: WebUiState = getDefaultState(),
): Promise<string> {
  if (s.server) return Promise.resolve(s.url);
  if (s.starting) return s.starting;
  if (!isLoopback(s.host) && !s.token) {
    return Promise.reject(new Error(`refusing to bind ${s.host} without a token (non-loopback)`));
  }
  const desired = Number(process.env.MMA_WEBUI_PORT) || 0;
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

export function stopServer(s: WebUiState = getDefaultState()): void {
  for (const client of s.clients) {
    try {
      client.end();
    } catch {
      /* best-effort cleanup */
    }
  }
  s.clients.clear();
  if (s.server) {
    try {
      s.server.close();
    } catch {
      /* best-effort cleanup */
    }
    s.server = null;
  }
  s.starting = null;
  s.busy = false;
  s.agentRunning = false;
  s.turnToken = null;
  s.lastPostTs = 0;
}
