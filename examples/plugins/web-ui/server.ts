/**
 * HTTP + SSE + REST server for the web-ui plugin.
 *
 * Transport is node:http (works under both Bun and the Node dist). The
 * frontend page is read from disk at startup and served verbatim (never
 * template-processed), so escape sequences inside the page's <script> stay
 * literal. Downstream events flow over SSE (/events); upstream input via
 * POST /api/message and POST /api/interrupt.
 *
 * Handlers take an explicit state object (`s`) so tests can run hermetically
 * against a fresh state instead of the process-global one; plugin.ts uses the
 * global default.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { HOST, MAX_CLIENTS, MAX_MESSAGE_CHARS, MAX_IMAGES } from "./state";
import { broadcast, flush } from "./state";
import type { WebUiState } from "./state";
import { validateMessageBody, scrub } from "./util";
import { readHistoryTail } from "./history";
import { readPlans } from "./plans-snap";

export interface WebUiAssets {
  html: string;
  css: string;
  js: string;
}

/** Max bytes accepted for a POST body (32KB text or 3×~6MB images + JSON overhead). */
const MAX_BODY_BYTES = 24 * 1024 * 1024;

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Token auth for /api/* endpoints. When MMA_WEBUI_TOKEN is set it is required
 * (header `x-mma-token` or `?token=`); when unset only loopback bindings are
 * expected — startServer refuses non-loopback binds without a token.
 */
export function checkAuth(req: IncomingMessage, reqUrl: URL): boolean {
  const token = process.env.MMA_WEBUI_TOKEN;
  if (!token) return true;
  const header = req.headers["x-mma-token"];
  if (typeof header === "string" && header === token) return true;
  return reqUrl.searchParams.get("token") === token;
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
        reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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

export function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  assets: WebUiAssets,
  s: WebUiState,
): void {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || HOST}`);

  // ---- SSE stream ----------------------------------------------------------
  if (reqUrl.pathname === "/events") {
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
    res.write(
      `event: session\ndata: ${JSON.stringify({ session: s.sessionMeta, url: s.url, busy: s.busy })}\n\n`,
    );
    res.write(`event: state\ndata: ${JSON.stringify({ busy: s.busy })}\n\n`);
    s.clients.add(res);
    const hb = setInterval(() => {
      try {
        res.write(`: hb ${Date.now()}\n\n`);
      } catch {
        clearInterval(hb);
      }
    }, 15_000);
    req.on("close", () => {
      clearInterval(hb);
      s.clients.delete(res);
    });
    return;
  }

  // ---- static assets (verbatim) ---------------------------------------------
  if (reqUrl.pathname === "/" || reqUrl.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(assets.html);
    return;
  }
  if (reqUrl.pathname === "/styles.css") {
    res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
    res.end(assets.css);
    return;
  }
  if (reqUrl.pathname === "/app.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    res.end(assets.js);
    return;
  }

  // ---- API ------------------------------------------------------------------
  if (reqUrl.pathname.startsWith("/api/")) {
    if (!checkAuth(req, reqUrl)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (!sameOrigin(req, reqUrl)) {
      sendJson(res, 403, { error: "cross-origin requests are not allowed" });
      return;
    }

    if (reqUrl.pathname === "/api/state" && req.method === "GET") {
      const plans = readPlans(s);
      sendJson(res, 200, {
        session: s.sessionMeta,
        busy: s.busy,
        url: s.url,
        plan: plans.active,
        drafts: plans.drafts,
        archived: plans.archived,
        history: readHistoryTail(s.configDir, s.sessionMeta?.id, s.historyTail),
      });
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
      if (
        s.minPostIntervalMs > 0 &&
        Date.now() - s.lastPostTs < s.minPostIntervalMs
      ) {
        sendJson(res, 429, { error: "rate_limited" });
        return;
      }
      readBody(req)
        .then((raw) => JSON.parse(raw))
        .then((body) =>
          validateMessageBody(body, MAX_MESSAGE_CHARS, MAX_IMAGES),
        )
        .then((v) => {
          if (!v.ok) {
            sendJson(res, v.status ?? 400, { error: v.error });
            return;
          }
          s.lastPostTs = Date.now();
          s.busy = true;
          broadcast({ type: "state", ts: Date.now(), busy: true }, s);
          // Fire-and-forget: the turn streams over SSE; errors surface there.
          s.bridge
            ?.submit(v.text!, { images: v.images })
            .catch((err: Error) => {
              s.busy = false;
              broadcast(
                {
                  type: "turn_end",
                  ts: Date.now(),
                  success: false,
                  error: scrub(err?.message || String(err)),
                },
                s,
              );
            });
          sendJson(res, 202, { ok: true });
        })
        .catch((err: NodeJS.ErrnoException) => {
          if (err?.code === "BODY_TOO_LARGE") {
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
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

export function startServer(assets: WebUiAssets, s: WebUiState): Promise<string> {
  if (s.server) return Promise.resolve(s.url);
  if (s.starting) return s.starting;
  const token = process.env.MMA_WEBUI_TOKEN;
  if (!isLoopback(HOST) && !token) {
    return Promise.reject(
      new Error(`refusing to bind ${HOST} without MMA_WEBUI_TOKEN (non-loopback)`),
    );
  }
  const desired = Number(process.env.MMA_WEBUI_PORT) || 0;
  s.starting = new Promise<string>((resolve, reject) => {
    const srv = createServer((req, res) => handleRequest(req, res, assets, s));
    srv.on("error", (err: NodeJS.ErrnoException) => {
      s.starting = null;
      reject(err);
    });
    srv.listen(desired, HOST, () => {
      s.server = srv as Server;
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : desired;
      s.url = `http://${HOST}:${port}`;
      s.starting = null;
      resolve(s.url);
    });
  });
  return s.starting;
}

export function stopServer(s: WebUiState): void {
  flush(s);
  if (s.clients.size > 0) {
    for (const client of s.clients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    s.clients.clear();
  }
  if (s.server) {
    try {
      s.server.close();
    } catch {
      /* ignore */
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
    /* best-effort */
  }
}
