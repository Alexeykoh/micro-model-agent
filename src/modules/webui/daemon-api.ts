/**
 * Web-адаптер в режиме `mma web --daemon <url>` (split W4).
 *
 * Браузерный `/api/*` здесь проксируется в host wire демона: сам web-процесс
 * не держит `Agent`/`SessionManager`. Непокрытые панели (files/git/lsp/…)
 * отвечают `501` с причиной, а не притворяются пустыми.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_BODY_BYTES, readJsonBody } from "../../runtime/http-body";
import { broadcast, type WebUiState } from "./state";
import { sendJson } from "./util";
import { webCommandList } from "./chat/commands";
import type { WebDaemonHost } from "./daemon-contracts";

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  reqUrl: URL;
  s: WebUiState & { daemon?: WebDaemonHost };
  host: WebDaemonHost;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

/** Точные маршруты `METHOD /api/...`. */
const ROUTES: Record<string, Handler> = {
  "GET /api/state": async ({ res, host }) => {
    const state = await host.getState();
    sendJson(res, 200, {
      busy: state.busy,
      runningSessionIds: state.busy && state.sessionId ? [state.sessionId] : [],
      queueLen: 0,
      state,
    });
  },
  "GET /api/config": async ({ res, host }) => {
    sendJson(res, 200, await host.getConfig());
  },
  "POST /api/config": async ({ req, res, host }) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body) return sendJson(res, 400, { ok: false, error: "invalid JSON" });
    const result = await host.setConfig(String(body.key ?? ""), body.value);
    sendJson(res, result.ok ? 200 : 400, result);
  },
  "GET /api/models": async ({ res, reqUrl, host }) => {
    const provider = reqUrl.searchParams.get("provider") ?? undefined;
    sendJson(res, 200, await host.listModels(provider));
  },
  "GET /api/commands": ({ res }) => {
    sendJson(res, 200, { commands: webCommandList() });
  },
  "GET /api/sessions": async ({ res, host }) => {
    sendJson(res, 200, { sessions: await host.listSessions() });
  },
  "POST /api/sessions": async ({ req, res, host }) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : undefined;
    const meta = await host.createSession(name);
    sendJson(res, 201, meta);
  },
  "POST /api/message": async ({ req, res, host }) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body) return sendJson(res, 400, { error: "invalid JSON" });
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) return sendJson(res, 400, { error: "empty" });
    if (typeof body.sessionId === "string" && body.sessionId) host.setSessionId(body.sessionId);
    const images = Array.isArray(body.images)
      ? body.images.filter((x): x is string => typeof x === "string")
      : [];
    await host.submit(text, images.length ? { images } : undefined);
    sendJson(res, 202, { ok: true, queued: 0 });
  },
  "POST /api/answer": async ({ req, res, host }) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body) return sendJson(res, 400, { error: "invalid JSON" });
    await host.answer(String(body.id ?? ""), body.answer);
    sendJson(res, 202, { ok: true });
  },
  "POST /api/interrupt": ({ res, host }) => {
    host.interrupt();
    sendJson(res, 202, { ok: true });
  },
  "POST /api/pause": async ({ res, host }) => {
    await host.pause();
    sendJson(res, 202, { ok: true });
  },
  "POST /api/resume": async ({ res, host }) => {
    await host.resume();
    sendJson(res, 202, { ok: true });
  },
  "POST /api/command": async ({ req, res, s, host }) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body) return sendJson(res, 400, { error: "invalid JSON" });
    const result = await host.executeCommand(String(body.line ?? ""));
    broadcast(
      {
        type: "command",
        ts: Date.now(),
        lines: result.output,
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
      },
      s,
    );
    sendJson(res, 200, result);
  },
};

/** `METHOD /api/sessions/:id[/history|/log]`. */
async function sessionRoute(ctx: Ctx): Promise<boolean> {
  const parts = ctx.reqUrl.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "sessions" || parts.length < 3) return false;
  const id = decodeURIComponent(parts[2]);
  if (ctx.req.method === "DELETE" && parts.length === 3) {
    await ctx.host.deleteSession(id);
    ctx.res.writeHead(204);
    ctx.res.end();
    return true;
  }
  if (ctx.req.method !== "GET") return false;
  if (parts.length === 4 && parts[3] === "history") {
    sendJson(ctx.res, 200, { messages: await ctx.host.getHistory(id) });
    return true;
  }
  if (parts.length === 4 && parts[3] === "log") {
    const since = ctx.reqUrl.searchParams.get("since") ?? undefined;
    const raw = ctx.reqUrl.searchParams.get("limit");
    const limit = raw && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
    sendJson(ctx.res, 200, {
      entries: await ctx.host.getLog(id, {
        ...(since ? { since } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    });
    return true;
  }
  return false;
}

/** Точка входа daemon-режима; существующий `handleApi` делегирует сюда. */
export async function handleDaemonApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: WebUiState & { daemon?: WebDaemonHost },
): Promise<void> {
  const host = s.daemon;
  if (!host) {
    sendJson(res, 503, { error: "daemon not configured" });
    return;
  }
  const ctx: Ctx = { req, res, reqUrl, s, host };
  const route = ROUTES[`${req.method} ${reqUrl.pathname}`];
  try {
    if (route) {
      await route(ctx);
      return;
    }
    if (await sessionRoute(ctx)) return;
    sendJson(res, 501, { error: "not supported in daemon mode", path: reqUrl.pathname });
  } catch (err) {
    sendJson(res, 502, {
      error: "daemon request failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
