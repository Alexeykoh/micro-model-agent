/**
 * Маршруты web-адаптера в daemon-режиме (split W11): таблица и её хелперы.
 * Транспорт/диспетчер — в `daemon-api.ts`, чтобы файл оставался ≤300 строк.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_BODY_BYTES, readJsonBody } from "../../runtime/http-body";
import { broadcast, type WebUiState } from "./state";
import { sendJson } from "./util";
import { handleI18nGet } from "./i18n/i18n-api";
import { handleFaviconGet } from "./favicon";
import type { WebDaemonHost } from "./daemon-contracts";

/** Контекст одного запроса адаптера. */
export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  reqUrl: URL;
  s: WebUiState & { daemon?: WebDaemonHost };
  host: WebDaemonHost;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

/** Точные маршруты `METHOD /api/...`. */
export const ROUTES: Record<string, Handler> = {
  "GET /api/state": async ({ res, host }) => {
    const state = await host.getState();
    const ids = state.queuedIds ?? [];
    sendJson(res, 200, {
      busy: state.busy,
      runningSessionIds: state.busy && state.sessionId ? [state.sessionId] : [],
      queueLen: ids.length,
      queued: ids.length ? { [state.sessionId ?? ""]: ids.length } : {},
      queuedIds: ids.length ? { [state.sessionId ?? ""]: ids } : {},
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
  "POST /api/update": async ({ res, host }) => {
    sendJson(res, 200, await host.installUpdate());
  },
  "GET /api/plugins": async ({ res, host }) => {
    sendJson(res, 200, await host.plugins());
  },
  "GET /api/setup": async ({ res, host }) => {
    sendJson(res, 200, await host.setup());
  },
  "POST /api/setup": async ({ req, res, host }) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body) return sendJson(res, 400, { ok: false, error: "invalid JSON" });
    const result = await host.setupApply(body);
    sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
  },
  "POST /api/setup/scan": async ({ res, host }) => {
    sendJson(res, 200, await host.setupScan());
  },
  "POST /api/setup/models": async ({ req, res, host }) =>
    setupProbe(req, res, host, "models"),
  "POST /api/setup/test": async ({ req, res, host }) => setupProbe(req, res, host, "test"),
  "POST /api/setup/context": async ({ req, res, host }) =>
    setupProbe(req, res, host, "context"),
  "POST /api/setup/locale": async ({ req, res, host }) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const result = await host.setupLocale(String(body?.locale ?? ""));
    sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
  },
  "POST /api/index": async ({ res, host }) => {
    sendJson(res, 202, await host.reindex());
  },
  "GET /api/lsp": async ({ res, host }) => {
    sendJson(res, 200, await host.lspServers());
  },
  "GET /api/lsp/doctor": async ({ res, host }) => {
    sendJson(res, 200, await host.lspDoctorGet());
  },
  "POST /api/lsp/doctor": async ({ res, host }) => {
    const result = await host.lspDoctorRun();
    sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
  },
  "POST /api/lsp/check": async ({ req, res, host }) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const result = await host.lspCheck(typeof body?.path === "string" ? body.path : "");
    sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
  },
  "POST /api/lsp/check-changed": async ({ res, host }) => {
    const result = await host.lspCheckChanged();
    sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
  },
  "GET /api/memory": async ({ res, host }) => {
    sendJson(res, 200, await host.memory());
  },
  "POST /api/memory": async ({ req, res, host }) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body) return sendJson(res, 400, { ok: false, error: "invalid JSON" });
    const result = await host.memoryAdd(String(body.category ?? ""), String(body.text ?? ""));
    sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
  },
  "POST /api/reload/plugins": async ({ res, host }) => {
    const result = await host.pluginsReload();
    sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
  },
  "GET /api/skills": async ({ res, host }) => {
    sendJson(res, 200, await host.skills());
  },
  "GET /api/git": async ({ res, host }) => {
    sendJson(res, 200, await host.gitSnapshot());
  },
  "GET /api/git/changes": async ({ res, host }) => {
    sendJson(res, 200, await host.gitChanges());
  },
  "GET /api/git/diff": async ({ res, reqUrl, host }) => {
    const path = reqUrl.searchParams.get("path") ?? "";
    sendJson(res, 200, await host.gitDiff(path, reqUrl.searchParams.get("staged") === "1"));
  },
  "GET /api/files": async ({ res, reqUrl, host }) => {
    sendJson(res, 200, await host.listFiles(reqUrl.searchParams.get("path") ?? ""));
  },
  "GET /api/file": async ({ reqUrl, res, host }) => {
    const view = await host.fileView(
      reqUrl.searchParams.get("path") ?? "",
      reqUrl.searchParams.get("download") === "1",
    );
    res.writeHead(view.status, { "Content-Type": view.mime, "Cache-Control": "no-store" });
    res.end(view.bytes);
  },
  "POST /api/queue/cancel": async ({ req, res, s, host }) =>
    queueAction(req, res, s, host, "cancel"),
  "POST /api/queue/start": async ({ req, res, s, host }) =>
    queueAction(req, res, s, host, "start"),
  "POST /api/queue/edit": async ({ req, res, s, host }) =>
    queueAction(req, res, s, host, "edit"),
  "GET /api/i18n": ({ res, s }) => handleI18nGet(res, s),
  "GET /api/favicon": async ({ res, host }) => {
    const state = await host.getState().catch(() => undefined);
    handleFaviconGet(res, { workspace: state?.workspace });
  },
  "GET /api/search": async ({ res, reqUrl, host }) => {
    const q = (reqUrl.searchParams.get("q") ?? "").trim();
    if (!q) return sendJson(res, 400, { error: "missing_query" });
    sendJson(res, 200, await host.search(q, reqUrl.searchParams.get("names") === "1"));
  },
  "GET /api/providers": async ({ res, host }) => {
    sendJson(res, 200, await host.providers());
  },
  "POST /api/providers": async ({ req, res, host }) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body) return sendJson(res, 400, { ok: false, error: "invalid JSON" });
    const result = await host.saveProvider(body);
    sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
  },
  "GET /api/mcp": async ({ res, host }) => {
    sendJson(res, 200, await host.mcpList());
  },
  "POST /api/mcp": async ({ req, res, host }) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body) return sendJson(res, 400, { ok: false, error: "invalid JSON" });
    const result = await host.mcpCreate(body);
    sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
  },
  "GET /api/commands": async ({ res, host }) => {
    const catalog = (await host.commands()) as {
      commands?: Array<{ name: string; description: string; usage?: string; available: boolean }>;
    };
    sendJson(res, 200, {
      commands: (catalog.commands ?? []).map((c) => ({
        name: c.name,
        usage: c.usage ?? `/${c.name}`,
        desc: c.available ? c.description : `${c.description} (terminal-only)`,
      })),
    });
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

/** Проба визарда (`models|test|context`) → host wire. */
async function setupProbe(
  req: IncomingMessage,
  res: ServerResponse,
  host: WebDaemonHost,
  kind: "models" | "test" | "context",
): Promise<void> {
  const body = (await readJsonBody(req, MAX_BODY_BYTES)) ?? {};
  const result =
    kind === "models"
      ? await host.setupModels(body)
      : kind === "test"
        ? await host.setupTest(body)
        : await host.setupContext(body);
  sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
}

/** `/api/plugins/:name[/settings]` → host wire (тумблер/настройки). */
export async function pluginRoute(
  req: IncomingMessage,
  host: WebDaemonHost,
  rest: string,
): Promise<{ status: number; body: unknown } | undefined> {
  const isSettings = rest.endsWith("/settings");
  const name = decodeURIComponent(isSettings ? rest.slice(0, rest.length - "/settings".length) : rest);
  if (!name) return undefined;
  if (isSettings) {
    if (req.method === "GET") return host.pluginSettingsGet(name);
    if (req.method === "PUT") {
      const body = await readJsonBody(req, MAX_BODY_BYTES);
      return host.pluginSettingsPut(name, (body?.values ?? {}) as Record<string, unknown>);
    }
    return undefined;
  }
  if (req.method === "POST") {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    return host.pluginToggle(name, Boolean(body?.enabled));
  }
  return undefined;
}

/** Действие очереди из браузера → host wire; статус/тело пробрасываются. */async function queueAction(
  req: IncomingMessage,
  res: ServerResponse,
  s: WebUiState & { daemon?: WebDaemonHost },
  host: WebDaemonHost,
  action: "cancel" | "edit" | "start",
): Promise<void> {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const sessionId =
    (typeof body?.sessionId === "string" && body.sessionId.trim()) ||
    (await host.getState().catch(() => undefined))?.sessionId;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!sessionId || !id) return sendJson(res, 400, { error: "bad_request" });
  const text = typeof body?.text === "string" ? body.text : undefined;
  const result = await host.queueAction(sessionId, action, id, text);
  if (result.status < 300) broadcast({ type: "state", ts: Date.now() }, s);
  sendJson(res, result.status, (result.body ?? {}) as Record<string, unknown>);
}

