/**
 * Transport helpers for the `mma web` server.
 *
 * Split out of `server.ts` to keep each file well under the 300-line budget
 * (rule #1). Pure-ish request/response plumbing — no app state transitions.
 */
import { exec } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { errMsg } from "../../utils/error";
import { redactContextSecrets } from "../../core/agent/context-log";
import type { WebUiState } from "./state";
import { broadcast, releaseBusy, reserveBusy } from "./state";

/** Max bytes accepted for a POST body (32KB text or 3×~6MB images + JSON overhead). */
export const MAX_BODY_BYTES = 24 * 1024 * 1024;

/** Hard cap on a single message's text, independent of the transport body cap. */
export const MAX_MESSAGE_CHARS = 32 * 1024;

/** Thrown by readBody when the payload exceeds the cap (maps to HTTP 413). */
export class BodyTooLargeError extends Error {
  constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Constant-time string compare; unequal lengths short-circuit (timingSafeEqual throws). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Token auth for HTTP surfaces (header `x-mma-token` or `?token=`); no token → allow. */
export function checkAuth(req: IncomingMessage, reqUrl: URL, s: WebUiState): boolean {
  if (!s.token) return true;
  const header = req.headers["x-mma-token"];
  if (typeof header === "string" && safeEqual(header, s.token)) return true;
  const query = reqUrl.searchParams.get("token");
  return query !== null && safeEqual(query, s.token);
}

/** Reject browser-initiated cross-origin writes (CSRF hardening). */
export function sameOrigin(req: IncomingMessage, reqUrl: URL): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / same-origin GET
  try {
    return new URL(String(origin)).host === reqUrl.host;
  } catch {
    return false;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Buffer a request body up to `cap`. Rejects with `BodyTooLargeError` on
 * overflow WITHOUT destroying the socket: the caller owns the 413 response and
 * drops the request only after the response is flushed — иначе клиент получает
 * socket error вместо 413.
 */
export function readBody(req: IncomingMessage, cap = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > cap) {
        settled = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/** Pull `{ text, images }` out of a parsed body; invalid JSON and empty are distinct. */
export function parseMessageBody(
  raw: string,
): { text: string; images: string[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "invalid JSON" };
  }
  const rec =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const text = (typeof rec.text === "string" ? rec.text : "").slice(0, MAX_MESSAGE_CHARS);
  const images = Array.isArray(rec.images)
    ? rec.images.filter((i): i is string => typeof i === "string")
    : [];
  if (text.trim().length === 0 && images.length === 0) return { error: "empty" };
  return { text, images };
}

/**
 * Redact credentials from an error message before it enters an SSE payload.
 * Reuses `redactContextSecrets` (точечная редакция) — generic `sanitizeLogMessage`
 * would mangle ordinary text, and the web UI shows these to users.
 */
export function scrubError(err: unknown): string {
  return redactContextSecrets(errMsg(err));
}

/** Map a body-read failure to a response; oversized bodies get a flush-safe 413. */
export function readBodyError(
  req: IncomingMessage,
  res: ServerResponse,
  err: unknown,
): void {
  if (err instanceof BodyTooLargeError) {
    res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
    // Destroy the request only after the 413 is flushed; destroying first makes
    // the client see a socket error instead of the status.
    res.end(JSON.stringify({ error: "body too large" }), () => req.destroy());
    return;
  }
  sendJson(res, 400, { error: "bad request" });
}

/**
 * `POST /api/message`: reserve the single-flight slot and forward to the host.
 *
 * Single-flight invariant: the busy pre-check and {@link reserveBusy} happen in
 * ONE synchronous tick (no `await` between them), so two concurrent POSTs can
 * never both pass. `bridge.isBusy()` tracks an actually-running turn
 * (`agentRunning`), distinct from this UI reservation (`s.busy`) — that is what
 * lets the owner's `submit` clear the host's own `isBusy()` guard. The
 * forwarder's `turn_end` is the sole reset for a turn that started;
 * `releaseBusy` covers a submit that never started.
 */
export function handleMessagePost(
  req: IncomingMessage,
  res: ServerResponse,
  s: WebUiState,
): void {
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
  const token = reserveBusy(s);
  broadcast({ type: "state", ts: Date.now(), busy: true }, s);
  readBody(req, s.maxBodyBytes)
    .then((raw) => {
      const body = parseMessageBody(raw);
      if ("error" in body) {
        if (releaseBusy(s, token)) {
          broadcast({ type: "state", ts: Date.now(), busy: false }, s);
        }
        sendJson(res, 400, { error: body.error });
        return;
      }
      s.lastPostTs = Date.now();
      const run = Promise.resolve(bridge.submit(body.text, { images: body.images }));
      run.catch((err: unknown) => {
        // Broadcast the failure either way; only the owning reservation may
        // clear `busy` (a started turn is reset by the forwarder's turn_end).
        broadcast({ type: "error", ts: Date.now(), error: scrubError(err) }, s);
        if (releaseBusy(s, token)) {
          broadcast({ type: "state", ts: Date.now(), busy: false }, s);
        }
      });
      sendJson(res, 202, { ok: true });
    })
    .catch((err: unknown) => {
      if (releaseBusy(s, token)) {
        broadcast({ type: "state", ts: Date.now(), busy: false }, s);
      }
      readBodyError(req, res, err);
    });
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
