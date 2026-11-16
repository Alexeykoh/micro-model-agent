/**
 * Web-адаптер в режиме `mma web --daemon <url>` (split W4).
 *
 * Браузерный `/api/*` здесь проксируется в host wire демона: сам web-процесс
 * не держит `Agent`/`SessionManager`. Непокрытые панели (files/git/lsp/…)
 * отвечают `501` с причиной, а не притворяются пустыми.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_BODY_BYTES, readJsonBody } from "../../runtime/http-body";
import type { WebUiState } from "./state";
import { sendJson } from "./util";
import type { WebDaemonHost } from "./daemon-contracts";
import { handleOsThemeGet } from "./settings/os-theme";
import { ROUTES, pluginRoute, type Ctx } from "./daemon-api-routes";

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
  if (parts.length === 6 && parts[3] === "subagents" && parts[5] === "interrupt") {
    if (ctx.req.method !== "POST") return false;
    sendJson(ctx.res, 200, await ctx.host.interruptSubagent(id, decodeURIComponent(parts[4])));
    return true;
  }
  if (ctx.req.method !== "GET") return false;
  if (parts.length === 5 && parts[3] === "images") {
    const img = await ctx.host.readImage(id, decodeURIComponent(parts[4]));
    if (!img) {
      sendJson(ctx.res, 404, { error: "not_found" });
      return true;
    }
    ctx.res.writeHead(200, {
      "Content-Type": img.mime,
      "Cache-Control": "private, max-age=31536000, immutable",
    });
    ctx.res.end(img.bytes);
    return true;
  }
  if (parts.length === 4 && parts[3] === "system-prompt") {
    sendJson(ctx.res, 200, await ctx.host.sessionPrompt(id));
    return true;
  }
  if (parts.length === 4 && parts[3] === "security") {
    const raw = ctx.reqUrl.searchParams.get("limit");
    const limit = raw && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
    sendJson(ctx.res, 200, await ctx.host.sessionSecurity(id, limit));
    return true;
  }
  if (parts.length === 4 && parts[3] === "subagents") {
    sendJson(
      ctx.res,
      200,
      await ctx.host.subagentRuns(id, ctx.reqUrl.searchParams.get("toolCallId") ?? undefined),
    );
    return true;
  }
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
    if (req.method === "GET" && reqUrl.pathname === "/api/os-theme") {
      handleOsThemeGet(res);
      return;
    }
    if (route) {
      await route(ctx);
      return;
    }
    if (await sessionRoute(ctx)) return;
    if (reqUrl.pathname.startsWith("/api/providers/") && req.method === "DELETE") {
      const name = decodeURIComponent(reqUrl.pathname.slice("/api/providers/".length));
      const result = await host.deleteProvider(name);
      sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
      return;
    }
    if (reqUrl.pathname.startsWith("/api/mcp/")) {
      const id = decodeURIComponent(reqUrl.pathname.slice("/api/mcp/".length));
      const result =
        req.method === "POST"
          ? await host.mcpToggle(id, Boolean((await readJsonBody(req, MAX_BODY_BYTES))?.enabled))
          : req.method === "PUT"
            ? await host.mcpUpdate(
                id,
                (await readJsonBody(req, MAX_BODY_BYTES)) ?? {},
              )
            : req.method === "DELETE"
              ? await host.mcpDelete(id)
              : undefined;
      if (!result) {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
      return;
    }
    if (reqUrl.pathname.startsWith("/api/memory/") && req.method === "DELETE") {
      const [category, n] = reqUrl.pathname
        .slice("/api/memory/".length)
        .split("/")
        .map((part) => decodeURIComponent(part));
      const result = await host.memoryDelete(category ?? "", Number(n));
      sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
      return;
    }
    if (reqUrl.pathname.startsWith("/api/plugins/")) {
      const rest = reqUrl.pathname.slice("/api/plugins/".length);
      const result = await pluginRoute(req, host, rest);
      if (!result) {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
      return;
    }
    if (reqUrl.pathname.startsWith("/api/lsp/") && req.method === "PUT") {
      const lang = decodeURIComponent(reqUrl.pathname.slice("/api/lsp/".length));
      const body = (await readJsonBody(req, MAX_BODY_BYTES)) ?? {};
      const result = await host.lspUpdate(lang, body);
      sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
      return;
    }
    // Неизвестный путь: честный 501, а не пустой успех.
    sendJson(res, 501, { error: "not supported in daemon mode", path: reqUrl.pathname });
  } catch (err) {
    sendJson(res, 502, {
      error: "daemon request failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
