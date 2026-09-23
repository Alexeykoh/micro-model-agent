/**
 * HTTP + SSE + REST transport for `mma web`.
 *
 * `handleRequest` is the pure app layer taking an explicit `WebUiState` so tests
 * drive it hermetically (rule #13: app creation separated from `listen()`).
 * `startServer`/`stopServer` default to a lazy process-global state for the CLI.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { errMsg } from "../../utils/error";
import { broadcast, createWebUiState } from "./state";
import type { WebUiState, WebUiAssets } from "./state";

/** Max bytes accepted for a POST body (32KB text or 3×~6MB images + JSON overhead). */
const MAX_BODY_BYTES = 24 * 1024 * 1024;

const MAX_CLIENTS = Number(process.env.MMA_WEBUI_MAX_CLIENTS) || 5;

/** Static routes served verbatim (never template-processed). */
const STATIC_ASSETS: Record<string, { type: string; key: keyof WebUiAssets }> = {
  "/index.html": { type: "text/html; charset=utf-8", key: "html" },
  "/styles.css": { type: "text/css; charset=utf-8", key: "css" },
  "/app.js": { type: "text/javascript; charset=utf-8", key: "js" },
};

/** Thrown by readBody when the payload exceeds the cap (maps to HTTP 413). */
class BodyTooLargeError extends Error {
  constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Token auth for `/api/*` (header `x-mma-token` or `?token=`); no token → allow. */
export function checkAuth(req: IncomingMessage, reqUrl: URL, s: WebUiState): boolean {
  if (!s.token) return true;
  const header = req.headers["x-mma-token"];
  if (typeof header === "string" && header === s.token) return true;
  return reqUrl.searchParams.get("token") === s.token;
}

/** Reject browser-initiated cross-origin writes (CSRF hardening). */
function sameOrigin(req: IncomingMessage, reqUrl: URL): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / same-origin GET
  try {
    return new URL(String(origin)).host === reqUrl.host;
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, cap = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Pull `{ text, images }` out of a parsed body; empty message → null. */
function parseMessageBody(raw: string): { text: string; images: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const rec =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const text = typeof rec.text === "string" ? rec.text : "";
  const images = Array.isArray(rec.images)
    ? rec.images.filter((i): i is string => typeof i === "string")
    : [];
  if (text.trim().length === 0 && images.length === 0) return null;
  return { text, images };
}

/** SSE handler: `/events` stream with client cap + heartbeat. */
function handleEvents(req: IncomingMessage, res: ServerResponse, s: WebUiState): void {
  if (s.clients.size >= MAX_CLIENTS) {
    sendJson(res, 503, { error: "too many clients" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 1200\n\n");
  res.write(`event: state\ndata: ${JSON.stringify({ busy: s.busy })}\n\n`);
  s.clients.add(res);
  const hb = setInterval(() => {
    try {
      res.write(`: hb ${Date.now()}\n\n`);
    } catch {
      clearInterval(hb); // клиент отвалился — heartbeat больше не нужен
    }
  }, 15_000);
  req.on("close", () => {
    clearInterval(hb);
    s.clients.delete(res);
  });
}

/** REST handler for `/api/*`; assumes auth + same-origin already checked. */
function handleApi(req: IncomingMessage, res: ServerResponse, reqUrl: URL, s: WebUiState): void {
  if (reqUrl.pathname === "/api/state" && req.method === "GET") {
    sendJson(res, 200, { busy: s.busy, state: s.bridge?.getState?.() ?? null });
    return;
  }

  if (reqUrl.pathname === "/api/message" && req.method === "POST") {
    if (!s.bridge) {
      sendJson(res, 503, { error: "no_bridge" });
      return;
    }
    if (s.busy || s.bridge.isBusy()) {
      sendJson(res, 409, { error: "busy" });
      return;
    }
    if (s.minPostIntervalMs > 0 && Date.now() - s.lastPostTs < s.minPostIntervalMs) {
      sendJson(res, 429, { error: "rate_limited" });
      return;
    }
    const bridge = s.bridge;
    readBody(req)
      .then((raw) => {
        const body = parseMessageBody(raw);
        if (!body) {
          sendJson(res, 400, { error: "empty message" });
          return;
        }
        s.lastPostTs = Date.now();
        s.busy = true;
        broadcast({ type: "state", ts: Date.now(), busy: true }, s);
        // Fire-and-forget: the turn streams over SSE; errors surface there.
        bridge.submit(body.text, { images: body.images }).catch((err: unknown) => {
          s.busy = false;
          broadcast({ type: "turn_end", ts: Date.now(), success: false, error: errMsg(err) }, s);
        });
        sendJson(res, 202, { ok: true });
      })
      .catch((err: unknown) => {
        if (err instanceof BodyTooLargeError) {
          sendJson(res, 413, { error: "body too large" });
        } else {
          sendJson(res, 400, { error: "invalid JSON body" });
        }
      });
    return;
  }

  if (reqUrl.pathname === "/api/interrupt" && req.method === "POST") {
    if (!s.busy && !s.bridge?.isBusy()) {
      sendJson(res, 409, { error: "idle" });
      return;
    }
    s.busy = false;
    s.bridge?.interrupt();
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

export function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  assets: WebUiAssets,
  s: WebUiState,
): void {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || s.host}`);

  if (reqUrl.pathname === "/events") {
    handleEvents(req, res, s);
    return;
  }

  const asset = STATIC_ASSETS[reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname];
  if (asset) {
    res.writeHead(200, { "Content-Type": asset.type });
    res.end(assets[asset.key]);
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
}

/** Best-effort open of the UI in the default browser (MMA_WEBUI_OPEN=0 disables). */
export function tryOpenBrowser(url: string): void {
  if (process.env.MMA_WEBUI_OPEN === "0") return;
  try {
    const platform = process.platform;
    const cmd =
      platform === "win32"
        ? `start "" "${url}"`
        : platform === "darwin"
          ? `open "${url}"`
          : `xdg-open "${url}"`;
    const child = exec(cmd, { windowsHide: true });
    child.unref?.();
  } catch {
    /* best-effort — opening a browser must never break startup */
  }
}
