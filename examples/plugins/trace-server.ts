/**
 * trace-server — live agent-loop trace in the browser.
 *
 * Single-file plugin, zero dependencies. Starts a local HTTP server when the
 * agent session starts and streams every loop event to the browser over SSE:
 * phases (thinking spinner), LLM calls (with task, timing, tool-call list),
 * tool start/end with full args/results and a compact arg summary, errors
 * (with stack), and streamed text/reasoning. No files are read — live only.
 *
 * Install:
 *   Windows:  copy to %USERPROFILE%\.mma\plugins\
 *   POSIX:    copy to ~/.mma/plugins/
 *   Project:  <project>/.mma/plugins/
 * Restart `mma`, open the URL printed at session start ("live trace → …").
 *
 * Config (env):
 *   MMA_TRACE_PORT         fixed port (default 0 = random free port)
 *   MMA_TRACE_HOST         bind address (default 127.0.0.1 — localhost only)
 *   MMA_TRACE_MAX_CLIENTS  SSE client cap (default 5)
 *   MMA_TRACE_OPEN         "0" disables auto-opening the browser at start
 *
 * Transport: SSE over node:http — works under both Bun and the Node dist.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { exec } from "node:child_process";

// ---- minimal structural types (duck-typed against AgentPlugin) ----

interface ToolCallLike {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
interface ToolResultLike {
  success: boolean;
  output: string;
  display?: string;
  diff?: string;
}
interface SessionMetaLike {
  id?: string;
  name?: string;
  model?: string;
  messageCount?: number;
  contextWindow?: number;
  projectDir?: string;
}
interface LLMResponseLike {
  type?: string;
  content?: string;
  calls?: ToolCallLike[];
}
interface PluginContext {
  iteration?: number;
  lastUserMessage?: string;
  logger?: {
    info(...a: unknown[]): void;
    warn(...a: unknown[]): void;
    debug(...a: unknown[]): void;
  };
  sessionManager?: SessionMetaLike;
  contextManager?: ContextManagerLike;
}

interface ContextBudgetLike {
  systemPrompt: number;
  responseReserve: number;
  history: number;
}

/** Duck-typed against src/modules/context/manager.ts ContextManager. */
interface ContextManagerLike {
  getBudget(): ContextBudgetLike;
  getEstimatedTokens(): number;
  getQuality(): number;
  getCompactionCount(): number;
  getIterationsSinceCompaction(): number;
  getMessageCount(): number;
}

// ---- server state (shared across module instances) ----
//
// The plugin can be loaded twice in one process (global + project dirs), which
// would start two servers. All mutable state lives in a process-global object
// keyed by a symbol, so any number of loaded instances share one server and
// one client set.

interface TraceState {
  server: Server | null;
  clients: Set<ServerResponse>;
  traceUrl: string;
  sessionMeta: SessionMetaLike | null;
  pending: { type: "text" | "meta"; text: string; iteration?: number } | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  llmStartTs: number | null;
  /** Last seen compaction count — used to detect new compactions. */
  lastCompactionCount: number;
  /** Context snapshot emitted before the previous event, for delta display. */
  lastContext: ContextSnapshot | null;
  /** In-flight startServer() promise — dedupes concurrent starts (the plugin
   * loads twice: global + project dirs; both onSessionStart hooks fire in the
   * same synchronous tick, before the first listen() callback sets `server`). */
  starting: Promise<string> | null;
}

interface ContextSnapshot {
  tokens: number;
  budget: ContextBudgetLike;
  quality: number;
  compactionCount: number;
  iterationsSinceCompaction: number;
  messageCount: number;
}

const HOST = process.env.MMA_TRACE_HOST || "127.0.0.1";
const MAX_CLIENTS = Math.max(1, Number(process.env.MMA_TRACE_MAX_CLIENTS) || 5);

const G = globalThis as unknown as Record<symbol, TraceState>;
const KEY = Symbol.for("mma.trace-server");
const state: TraceState =
  G[KEY] ||
  (G[KEY] = {
    server: null,
    clients: new Set<ServerResponse>(),
    traceUrl: "",
    sessionMeta: null,
    pending: null,
    flushTimer: null,
    llmStartTs: null,
    lastCompactionCount: 0,
    lastContext: null,
    starting: null,
  });

// ---- helpers ----

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
}

function safeJson(args: Record<string, unknown>): string {
  try {
    return clip(JSON.stringify(args, null, 2), 200_000);
  } catch {
    return clip(String(args), 200_000);
  }
}

/** One-line summary of the most salient args for quick scanning. */
function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (parts.length >= 4) {
      parts.push("…");
      break;
    }
    if (v === null || v === undefined) parts.push(`${k}: null`);
    else if (typeof v === "string") {
      parts.push(
        v.length <= 40 ? `${k}: ${JSON.stringify(v)}` : `${k}: ${JSON.stringify(v.slice(0, 40))}…(${v.length})`,
      );
    } else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}: ${v}`);
    else if (Array.isArray(v)) parts.push(`${k}: [${v.length}]`);
    else parts.push(`${k}: {…}`);
  }
  return parts.join(" · ");
}

// Safety net: mask credential-shaped values. Content stays otherwise intact.
const SECRET_FIELD = /(["']?(?:api[_-]?key|apikey|token|password|passwd|secret|authorization)["']?\s*[:=]\s*)(["']?)([^"',}\s]{8,})/gi;
function scrub(text: string): string {
  let out = text;
  out = out.replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-***");
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer ***");
  out = out.replace(SECRET_FIELD, "$1$2***");
  return out;
}

function broadcast(evt: Record<string, unknown>): void {
  const frame = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const client of state.clients) {
    try {
      client.write(frame);
    } catch {
      state.clients.delete(client);
    }
  }
}

function pushChunk(type: "text" | "meta", chunk: string, iteration?: number): void {
  if (!chunk) return;
  if (state.pending && state.pending.type !== type) flush();
  state.pending = state.pending && state.pending.type === type
    ? { type, text: state.pending.text + chunk, iteration: iteration ?? state.pending.iteration }
    : { type, text: chunk, iteration };
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.flushTimer = setTimeout(flush, 350);
}

function flush(): void {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  if (state.pending) {
    const p = state.pending;
    state.pending = null;
    broadcast({ type: p.type, ts: Date.now(), iteration: p.iteration, text: p.text });
  }
}

function snapshotContext(ctx: PluginContext): ContextSnapshot | null {
  const cm = ctx.contextManager;
  if (!cm) return null;
  try {
    return {
      tokens: cm.getEstimatedTokens(),
      budget: cm.getBudget(),
      quality: cm.getQuality(),
      compactionCount: cm.getCompactionCount(),
      iterationsSinceCompaction: cm.getIterationsSinceCompaction(),
      messageCount: cm.getMessageCount(),
    };
  } catch {
    return null;
  }
}

/** Emit a context snapshot + a compaction event when the count increased. */
function emitContext(ctx: PluginContext): void {
  const snap = snapshotContext(ctx);
  if (!snap) return;
  if (snap.compactionCount > state.lastCompactionCount && state.lastContext) {
    const before = state.lastContext;
    broadcast({
      type: "compaction",
      ts: Date.now(),
      iteration: ctx.iteration,
      compactionCount: snap.compactionCount,
      tokensBefore: before.tokens,
      tokensAfter: snap.tokens,
      qualityBefore: before.quality,
      qualityAfter: snap.quality,
      budgetHistory: snap.budget.history,
    });
  }
  state.lastCompactionCount = snap.compactionCount;
  // Dedupe: both global + project plugin instances call emitContext on the
  // same tick with an identical snapshot — skip the second broadcast.
  if (
    state.lastContext &&
    state.lastContext.tokens === snap.tokens &&
    state.lastContext.quality === snap.quality &&
    state.lastContext.compactionCount === snap.compactionCount &&
    state.lastContext.messageCount === snap.messageCount
  ) {
    state.lastContext = snap;
    return;
  }
  state.lastContext = snap;
  broadcast({
    type: "context",
    ts: Date.now(),
    iteration: ctx.iteration,
    tokens: snap.tokens,
    budget: snap.budget,
    quality: snap.quality,
    compactionCount: snap.compactionCount,
    iterationsSinceCompaction: snap.iterationsSinceCompaction,
    messageCount: snap.messageCount,
  });
}

// ---- http ----

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const reqUrl = new URL(req.url || "/", `http://${HOST}`);
  if (reqUrl.pathname === "/events") {
    if (state.clients.size >= MAX_CLIENTS) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Too many trace clients");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 1200\n\n");
    res.write(
      `event: session\ndata: ${JSON.stringify({ session: state.sessionMeta, url: state.traceUrl, connectedAt: Date.now() })}\n\n`,
    );
    state.clients.add(res);
    const hb = setInterval(() => {
      try {
        res.write(`: hb ${Date.now()}\n\n`);
      } catch {
        clearInterval(hb);
      }
    }, 15_000);
    req.on("close", () => {
      clearInterval(hb);
      state.clients.delete(res);
    });
    return;
  }
  if (reqUrl.pathname === "/" || reqUrl.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

function startServer(): Promise<string> {
  if (state.server) return Promise.resolve(state.traceUrl);
  if (state.starting) return state.starting;
  const desired = Number(process.env.MMA_TRACE_PORT) || 0;
  state.starting = new Promise<string>((resolve, reject) => {
    const attempt = (port: number, left: number) => {
      const srv = createServer(handleRequest);
      srv.on("error", (err: NodeJS.ErrnoException) => {
        if (port !== 0 && left > 0 && err.code === "EADDRINUSE") attempt(port + 1, left - 1);
        else {
          state.starting = null;
          reject(err);
        }
      });
      srv.listen(port, HOST, () => {
        state.server = srv;
        const addr = srv.address();
        const p = typeof addr === "object" && addr ? addr.port : port;
        state.traceUrl = `http://${HOST}:${p}`;
        state.starting = null;
        resolve(state.traceUrl);
      });
    };
    attempt(desired, 10);
  });
  return state.starting;
}

function stopServer(): void {
  flush();
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  for (const client of state.clients) {
    try {
      client.end();
    } catch {
      /* ignore */
    }
  }
  state.clients.clear();
  if (state.server) {
    try {
      state.server.close();
    } catch {
      /* ignore */
    }
    state.server = null;
  }
  state.starting = null;
  state.sessionMeta = null;
}

function tryOpenBrowser(url: string): void {
  if (process.env.MMA_TRACE_OPEN === "0") return;
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

// ---- plugin ----

export const plugin = {
  name: "trace-server",
  priority: 100,

  onSessionStart(ctx: PluginContext): void {
    state.sessionMeta = ctx.sessionManager || null;
    state.lastCompactionCount = 0;
    state.lastContext = null;
    startServer()
      .then((url) => {
        broadcast({ type: "system", ts: Date.now(), message: `Trace server ready: ${url}` });
        // Push the session snapshot to already-open pages too (not only on
        // SSE connect), so the header updates when a session (re)starts.
        broadcast({
          type: "session",
          ts: Date.now(),
          session: state.sessionMeta,
          url: state.traceUrl,
          connectedAt: Date.now(),
        });
        emitContext(ctx);
        ctx.logger?.info(`[trace-server] live trace → ${url}`);
        tryOpenBrowser(url);
      })
      .catch((err: Error) => {
        ctx.logger?.warn(`[trace-server] failed to start: ${err?.message || String(err)}`);
      });
  },

  onSessionEnd(): void {
    broadcast({ type: "system", ts: Date.now(), message: "Session ended — server closing" });
    stopServer();
  },

  onPhase(ctx: PluginContext, phase: string): void {
    flush();
    broadcast({ type: "phase", ts: Date.now(), iteration: ctx.iteration, phase });
  },

  onBeforeThink(ctx: PluginContext): void {
    flush();
    emitContext(ctx);
    state.llmStartTs = Date.now();
    broadcast({
      type: "llm_start",
      ts: Date.now(),
      iteration: ctx.iteration,
      task: ctx.lastUserMessage ? scrub(clip(ctx.lastUserMessage, 300)) : null,
    });
  },

  onAfterThink(ctx: PluginContext, response: LLMResponseLike | null): void {
    flush();
    emitContext(ctx);
    const durationMs = state.llmStartTs !== null ? Date.now() - state.llmStartTs : undefined;
    state.llmStartTs = null;
    broadcast({
      type: "llm_end",
      ts: Date.now(),
      iteration: ctx.iteration,
      kind: response?.type || null,
      callCount: response?.calls?.length || 0,
      callNames: response?.calls?.map((c) => c.name) || [],
      durationMs,
    });
  },

  onToolStart(ctx: PluginContext, call: ToolCallLike): void {
    flush();
    broadcast({
      type: "tool_start",
      ts: Date.now(),
      iteration: ctx.iteration,
      toolCallId: call.id,
      name: call.name,
      args: scrub(safeJson(call.arguments)),
      summary: scrub(summarizeArgs(call.arguments)),
    });
  },

  onToolEnd(
    ctx: PluginContext,
    call: ToolCallLike,
    result: ToolResultLike,
    durationMs: number,
  ): void {
    flush();
    emitContext(ctx);
    broadcast({
      type: "tool_end",
      ts: Date.now(),
      iteration: ctx.iteration,
      toolCallId: call.id,
      name: call.name,
      success: result.success,
      durationMs,
      output: scrub(clip(result.output || "", 100_000)),
    });
  },

  onError(ctx: PluginContext, err: Error): void {
    flush();
    broadcast({
      type: "error",
      ts: Date.now(),
      iteration: ctx.iteration,
      message: scrub(err?.message || String(err)),
      stack: err?.stack ? scrub(clip(err.stack, 5000)) : undefined,
    });
  },

  onText(ctx: PluginContext, chunk: string): void {
    pushChunk("text", chunk, ctx.iteration);
  },

  onMeta(ctx: PluginContext, chunk: string): void {
    pushChunk("meta", chunk, ctx.iteration);
  },
};

// ---- frontend (single self-contained page, no build step) ----

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MMA · trace</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%235cc8ff'/%3E%3C/svg%3E">
<style>
  :root {
    --bg: #0b0e14;
    --panel: #11151c;
    --panel2: #161b24;
    --border: #1f2630;
    --text: #d7dce5;
    --dim: #7c8695;
    --accent: #5cc8ff;
    --green: #3ddc84;
    --red: #ff5c5c;
    --yellow: #ffc857;
    --purple: #c792ea;
    --cyan: #56d4dd;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 13px/1.5 ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, Menlo, monospace;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 14px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .logo { font-weight: 700; font-size: 14px; letter-spacing: .5px; white-space: nowrap; }
  .logo b { color: var(--accent); }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .dot.live { background: var(--green); animation: pulse 1.6s ease-out infinite; }
  .dot.dead { background: var(--red); animation: pulse 1s ease-out infinite; }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(61,220,132,.45); }
    70% { box-shadow: 0 0 0 6px rgba(61,220,132,0); }
    100% { box-shadow: 0 0 0 0 rgba(61,220,132,0); }
  }
  .dot.dead { animation-name: pulseRed; }
  @keyframes pulseRed {
    0% { box-shadow: 0 0 0 0 rgba(255,92,92,.45); }
    70% { box-shadow: 0 0 0 6px rgba(255,92,92,0); }
    100% { box-shadow: 0 0 0 0 rgba(255,92,92,0); }
  }
  #session { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #session b { color: var(--text); font-weight: 600; }
  .spacer { flex: 1; }
  .spinner {
    display: inline-block; width: 11px; height: 11px; vertical-align: -1px;
    border: 2px solid rgba(255,200,87,.2); border-top-color: var(--yellow);
    border-radius: 50%;
    animation: spin .65s linear infinite;
  }
  .mini-spin {
    display: inline-block; width: 9px; height: 9px; vertical-align: -1px;
    border: 2px solid rgba(199,146,234,.25); border-top-color: var(--purple);
    border-radius: 50%;
    animation: spin .6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  #think { color: var(--yellow); display: none; align-items: center; gap: 7px; white-space: nowrap; }
  #think.on { display: flex; }
  #thinkTxt { font-size: 12px; }
  #elapsed { color: var(--dim); white-space: nowrap; }
  #status { font-size: 11px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
  #status.live { color: var(--green); background: rgba(61,220,132,.12); }
  #status.bad { color: var(--red); background: rgba(255,92,92,.12); }
  .toolbar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 6px 14px;
    background: var(--panel2);
    border-bottom: 1px solid var(--border);
  }
  .chip {
    cursor: pointer; user-select: none;
    padding: 2px 9px; border-radius: 10px;
    background: #1b222d; color: var(--dim);
    border: 1px solid var(--border);
  }
  .chip.on { color: var(--accent); border-color: var(--accent); background: rgba(92,200,255,.1); }
  #search {
    flex: 1; min-width: 120px;
    background: #0d1117; color: var(--text);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 4px 9px; font: inherit;
    outline: none;
  }
  #search:focus { border-color: var(--accent); }
  .btn {
    cursor: pointer;
    background: #1b222d; color: var(--dim);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 4px 10px; font: inherit; font-size: 12px;
  }
  .btn:hover { color: var(--text); border-color: #2c3646; }
  .btn.active { color: var(--yellow); border-color: var(--yellow); }
  #count { color: var(--dim); font-size: 11px; white-space: nowrap; }
  #log { flex: 1; overflow-y: auto; padding: 6px 10px 20px; }
  .entry {
    padding: 4px 8px; border-left: 2px solid transparent;
    animation: appear .12s ease-out;
  }
  @keyframes appear { from { opacity: 0; transform: translateY(-3px); } }
  .entry:hover { background: rgba(255,255,255,.02); border-left-color: var(--border); }
  .head { display: flex; align-items: baseline; gap: 8px; }
  .t { color: #4b5563; font-size: 11px; flex: none; }
  .iter { color: #4b5563; font-size: 11px; flex: none; background: rgba(124,134,149,.12); padding: 0 5px; border-radius: 4px; }
  .tag {
    flex: none; font-size: 10px; font-weight: 700; letter-spacing: 1px;
    padding: 1px 5px; border-radius: 4px; min-width: 42px; text-align: center;
  }
  .title { font-weight: 600; word-break: break-all; }
  .t-tool .tag { background: rgba(86,212,221,.15); color: var(--cyan); }
  .t-tool .title { color: var(--cyan); }
  .t-done .tag { background: rgba(61,220,132,.13); color: var(--green); }
  .t-done.fail .tag { background: rgba(255,92,92,.13); color: var(--red); }
  .t-done.fail .title { color: var(--red); }
  .t-llm .tag { background: rgba(199,146,234,.14); color: var(--purple); }
  .t-text .tag { background: rgba(215,220,229,.08); color: var(--text); }
  .t-meta .tag { background: rgba(124,134,149,.12); color: var(--dim); }
  .t-phase .tag { background: rgba(255,200,87,.12); color: var(--yellow); }
  .t-err .tag { background: rgba(255,92,92,.15); color: var(--red); }
  .t-sys .tag { background: rgba(124,134,149,.1); color: var(--dim); }
  .t-ctx .tag { background: rgba(255,200,87,.15); color: var(--yellow); }
  .t-ctx .title { color: var(--yellow); }
  .t-err { border-left-color: var(--red); }
  .body { margin-top: 3px; padding-left: 16px; color: var(--text); }
  .body.dim { color: var(--dim); }
  .summary { color: var(--dim); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .body > .summary { margin-bottom: 3px; }
  details { margin-top: 3px; }
  summary {
    cursor: pointer; color: var(--dim); font-size: 11px; user-select: none;
    display: inline-block;
  }
  summary:hover { color: var(--accent); }
  pre {
    margin: 3px 0 4px; padding: 6px 9px;
    background: #0d1117; border: 1px solid var(--border); border-radius: 6px;
    white-space: pre-wrap; word-break: break-word;
    max-height: 260px; overflow-y: auto; font: inherit; font-size: 12px; color: #aeb7c2;
  }
  details[open] summary { color: var(--accent); }
  .result { margin-top: 4px; font-size: 12px; }
  .result.ok { color: var(--green); }
  .result.bad { color: var(--red); }
  .empty { color: var(--dim); padding: 30px; text-align: center; }
  .paused-note {
    position: fixed; right: 14px; bottom: 14px;
    background: var(--yellow); color: #1a1204;
    padding: 5px 10px; border-radius: 8px; font-size: 12px; font-weight: 600;
    display: none; box-shadow: 0 2px 12px rgba(0,0,0,.4);
  }
  .ctxbar {
    display: flex; align-items: center; gap: 10px;
    padding: 3px 14px;
    background: #0d1117;
    border-bottom: 1px solid var(--border);
    font-size: 11px; color: var(--dim);
    white-space: nowrap;
  }
  .ctx-track {
    flex: 1; max-width: 220px; height: 7px;
    background: #1b222d; border-radius: 4px; overflow: hidden;
    position: relative;
  }
  .ctx-fill {
    height: 100%; min-width: 2px;
    background: var(--green);
    transition: width .25s ease;
  }
  .ctx-fill.warn { background: var(--yellow); }
  .ctx-fill.hot { background: var(--red); }
  .ctx-thresh {
    position: absolute; top: 0; bottom: 0; width: 1px;
    background: rgba(124,134,149,.5);
  }
  .ctx-info { display: flex; gap: 12px; flex-wrap: wrap; overflow: hidden; }
  .ctx-info b { color: var(--text); font-weight: 600; }
  .ctx-info .q-ok { color: var(--green); }
  .ctx-info .q-warn { color: var(--yellow); }
  .ctx-info .q-bad { color: var(--red); }
</style>
</head>
<body>
<header>
  <div class="logo"><span class="dot live" id="dot"></span>MMA&nbsp;·&nbsp;<b>trace</b></div>
  <div id="session"></div>
  <div class="spacer"></div>
  <div id="think"><span class="spinner"></span><span id="thinkTxt">thinking…</span></div>
  <div id="elapsed"></div>
  <div id="status">connecting…</div>
</header>
<div class="toolbar">
  <span class="chip on" data-g="tool">Tool</span>
  <span class="chip on" data-g="llm">LLM</span>
  <span class="chip on" data-g="text">Text</span>
  <span class="chip on" data-g="meta">Meta</span>
  <span class="chip on" data-g="phase">Phase</span>
  <span class="chip on" data-g="err">Err</span>
  <span class="chip on" data-g="sys">Sys</span>
  <span class="chip on" data-g="ctx">Ctx</span>
  <input id="search" type="text" placeholder="filter…  ( / )" autocomplete="off" spellcheck="false">
  <span id="count">0 events</span>
  <button class="btn" id="pause">Pause</button>
  <button class="btn" id="autoscroll" title="stick to bottom">Auto-scroll</button>
  <button class="btn" id="clear">Clear</button>
</div>
<div class="ctxbar" id="ctxbar">
  <div class="ctx-track" id="ctxTrack" title="context tokens / history budget">
    <div class="ctx-fill" id="ctxFill"></div>
    <div class="ctx-thresh" id="ctxThresh"></div>
  </div>
  <div class="ctx-info" id="ctxInfo">ctx —</div>
</div>
<div id="log"><div class="empty">Waiting for events…</div></div>
<div class="paused-note" id="pausedNote"></div>
<script>
(function () {
  'use strict';
  var log = document.getElementById('log');
  var countEl = document.getElementById('count');
  var empty = log.querySelector('.empty');

  var GROUP = {
    tool_start: 'tool', tool_end: 'tool',
    llm_start: 'llm', llm_end: 'llm',
    text: 'text', meta: 'meta',
    phase: 'phase', error: 'err', system: 'sys',
    context: 'ctx', compaction: 'ctx'
  };
  var CLASS = {
    tool_start: 't-tool', tool_end: 't-done',
    llm_start: 't-llm', llm_end: 't-llm',
    text: 't-text', meta: 't-meta',
    phase: 't-phase', error: 't-err', system: 't-sys',
    context: 't-ctx', compaction: 't-ctx'
  };
  var LABEL = {
    tool_start: 'TOOL', tool_end: 'DONE',
    llm_start: 'LLM', llm_end: 'LLM',
    text: 'TEXT', meta: 'META',
    phase: 'PHASE', error: 'ERR', system: 'SYS',
    context: 'CTX', compaction: 'CTX'
  };

  var active = { tool: true, llm: true, text: true, meta: true, phase: true, err: true, sys: true, ctx: true };
  var searchTerm = '';
  var paused = false;
  var stick = true;
  var total = 0;
  var openTools = {}; // toolCallId -> row element
  var openLlm = null; // in-flight llm_start row
  var deferred = [];
  var startTs = Date.now();
  var thinkStart = null;

  function fmtMs(ms) {
    if (ms === undefined || ms === null) return '';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  // chips
  var chips = document.querySelectorAll('.chip');
  chips.forEach(function (c) {
    c.addEventListener('click', function () {
      var g = c.getAttribute('data-g');
      active[g] = !active[g];
      c.classList.toggle('on', active[g]);
      apply();
    });
  });

  document.getElementById('search').addEventListener('input', function (e) {
    searchTerm = e.target.value.toLowerCase();
    apply();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      document.getElementById('search').focus();
    }
  });

  document.getElementById('pause').addEventListener('click', function () {
    paused = !paused;
    this.textContent = paused ? 'Resume' : 'Pause';
    this.classList.toggle('active', paused);
    var note = document.getElementById('pausedNote');
    if (paused) {
      note.textContent = 'paused · buffering';
      note.style.display = 'block';
    } else {
      note.style.display = 'none';
      if (deferred.length) {
        deferred.forEach(function (f) { f(); });
        deferred = [];
      }
      apply();
    }
  });

  document.getElementById('clear').addEventListener('click', function () {
    log.innerHTML = '';
    empty = null;
    openTools = {};
    openLlm = null;
    total = 0;
    countEl.textContent = '0 events';
  });

  document.getElementById('autoscroll').addEventListener('click', function () {
    stick = !stick;
    this.classList.toggle('active', !stick);
    if (stick) scrollBottom();
  });

  log.addEventListener('scroll', function () {
    if (log.scrollTop + log.clientHeight >= log.scrollHeight - 60) stick = true;
  });

  function now() {
    var d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(function (n) { return (n < 10 ? '0' : '') + n; }).join(':');
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function entry(type, tagText, titleEl, body, iter) {
    var e = el('div', 'entry ' + (CLASS[type] || type));
    e.dataset.type = type;
    e.dataset.g = GROUP[type] || type;
    var head = el('div', 'head');
    head.appendChild(el('span', 't', now()));
    head.appendChild(el('span', 'tag', tagText));
    if (iter !== undefined && iter !== null) head.appendChild(el('span', 'iter', '#' + iter));
    if (titleEl) head.appendChild(titleEl);
    e.appendChild(head);
    if (body) e.appendChild(body);
    return e;
  }

  function openDetails(summaryText, preText, cls) {
    var det = el('details');
    det.setAttribute('open', '');
    det.appendChild(el('summary', '', summaryText));
    det.appendChild(el('pre', cls, preText));
    return det;
  }

  function toolStart(e) {
    var body = el('div');
    body.appendChild(el('div', 'title', '▶ ' + e.name));
    if (e.summary) body.appendChild(el('div', 'summary', e.summary));
    if (e.args) body.appendChild(openDetails('args', e.args));
    return entry('tool_start', 'TOOL', null, body, e.iteration);
  }

  function toolEnd(e) {
    var row = openTools[e.toolCallId];
    if (row) {
      delete openTools[e.toolCallId];
      var title = row.querySelector('.title');
      var ok = e.success;
      if (title) title.textContent = (ok ? '✓ ' : '✗ ') + e.name + ' · ' + fmtMs(e.durationMs);
      row.classList.toggle('fail', !ok);
      var body = row.querySelector('.body') || el('div', 'body');
      var res = el('div', 'result ' + (ok ? 'ok' : 'bad'),
        (ok ? 'SUCCESS' : 'FAILED') + ' · ' + fmtMs(e.durationMs) + (e.iteration !== undefined ? ' · iter #' + e.iteration : ''));
      body.appendChild(res);
      if (e.output) body.appendChild(openDetails('output', e.output));
      row.appendChild(body);
      return null;
    }
    var b = el('div', 'body');
    b.appendChild(el('div', 'title', (e.success ? '✓ ' : '✗ ') + e.name + ' · ' + fmtMs(e.durationMs)));
    if (e.output) b.appendChild(openDetails('output', e.output));
    var row2 = entry('tool_end', 'DONE', null, b, e.iteration);
    row2.classList.toggle('fail', !e.success);
    return row2;
  }

  function llmStart(e) {
    var title = el('span', 'title');
    title.appendChild(el('span', 'mini-spin'));
    title.appendChild(document.createTextNode(' LLM call…'));
    var row = entry('llm_start', 'LLM', title, null, e.iteration);
    if (e.task) {
      var body = el('div', 'body dim');
      body.appendChild(el('div', 'summary', 'task: ' + e.task));
      row.appendChild(body);
    }
    openLlm = row;
    return row;
  }

  function llmEnd(e) {
    var t = '✓ LLM';
    var dur = fmtMs(e.durationMs);
    if (dur) t += ' · ' + dur;
    if (e.kind) t += ' · ' + e.kind;
    if (e.callCount) t += ' · ' + e.callCount + ' call(s)';
    if (e.callNames && e.callNames.length) t += ': ' + e.callNames.join(', ');
    var row = openLlm;
    if (row) {
      openLlm = null;
      var title = row.querySelector('.title');
      if (title) title.textContent = t;
      if (e.callNames && e.callNames.length) {
        var b = row.querySelector('.body') || el('div', 'body');
        b.appendChild(el('div', 'summary', '→ ' + e.callNames.join(', ')));
        row.appendChild(b);
      }
      return null;
    }
    return entry('llm_end', 'LLM', el('span', 'title', t), null, e.iteration);
  }

  function phaseRow(e) {
    var on = e.phase === 'thinking';
    if (on) thinkStart = Date.now();
    else thinkStart = null;
    setThinking(on);
    var title = el('span', 'title', on ? '● thinking…' : '○ done');
    return entry('phase', 'PHASE', title, null, e.iteration);
  }

  function errRow(e) {
    var title = el('span', 'title', '✖ ' + e.message);
    var body = null;
    if (e.stack) {
      body = el('div');
      body.appendChild(openDetails('stack', e.stack));
    }
    return entry('error', 'ERR', title, body, e.iteration);
  }

  function textRow(e) {
    var body = el('div', 'body' + (e.type === 'meta' ? ' dim' : ''), e.text);
    return entry(e.type, e.type === 'meta' ? 'META' : 'TEXT', null, body, e.iteration);
  }

  function sysRow(e) {
    return entry('system', 'SYS', el('span', 'title', e.message));
  }

  function compRow(e) {
    var title = el('span', 'title', '⟳ Compaction #' + e.compactionCount);
    var body = el('div', 'body');
    var before = e.tokensBefore || 0;
    var after = e.tokensAfter || 0;
    var removed = before - after;
    body.appendChild(el('div', 'result ' + (removed > 0 ? 'ok' : 'bad'),
      'tokens: ' + before + ' → ' + after + (removed !== 0 ? ' (−' + removed + ')' : '') +
      ' · quality: ' + e.qualityBefore + '% → ' + e.qualityAfter + '%'));
    var budget = e.budgetHistory || 0;
    if (budget) body.appendChild(el('div', 'summary', 'history budget: ' + budget));
    return entry('compaction', 'CTX', title, body, e.iteration);
  }

  function updateCtxBar(e) {
    var fill = document.getElementById('ctxFill');
    var thresh = document.getElementById('ctxThresh');
    var info = document.getElementById('ctxInfo');
    var budget = e.budget || {};
    var history = budget.history || 0;
    var pct = history ? Math.min(100, Math.round((e.tokens / history) * 100)) : 0;
    fill.style.width = pct + '%';
    fill.className = 'ctx-fill' + (pct >= 90 ? ' hot' : pct >= 75 ? ' warn' : '');
    thresh.style.left = '75%';
    var qCls = e.quality >= 70 ? 'q-ok' : e.quality >= 40 ? 'q-warn' : 'q-bad';
    var since = e.iterationsSinceCompaction !== undefined ? e.iterationsSinceCompaction : 0;
    info.innerHTML =
      '<span>ctx: <b>' + e.tokens + '/' + history + '</b> (' + pct + '%)</span>' +
      '<span>quality: <b class="' + qCls + '">' + e.quality + '%</b></span>' +
      '<span>compactions: <b>' + e.compactionCount + '</b></span>' +
      '<span>since: <b>' + since + '</b></span>' +
      '<span>msgs: <b>' + e.messageCount + '</b></span>';
  }

  var RENDER = {
    tool_start: toolStart,
    tool_end: toolEnd,
    llm_start: llmStart,
    llm_end: llmEnd,
    phase: phaseRow,
    error: errRow,
    text: textRow,
    meta: textRow,
    system: sysRow,
    compaction: compRow
  };

  function setThinking(on) {
    document.getElementById('think').classList.toggle('on', on);
  }

  // header thinking elapsed ticker
  setInterval(function () {
    var thinkEl = document.getElementById('thinkTxt');
    if (thinkStart) {
      var sec = (Date.now() - thinkStart) / 1000;
      thinkEl.textContent = 'thinking · ' + sec.toFixed(1) + 's';
    } else {
      thinkEl.textContent = 'thinking…';
    }
  }, 100);

  function scrollBottom() {
    log.scrollTop = log.scrollHeight;
  }

  function apply() {
    var nodes = log.children;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n.dataset || !n.dataset.g) continue;
      var visible = active[n.dataset.g] !== false;
      if (visible && searchTerm) {
        visible = (n.textContent || '').toLowerCase().indexOf(searchTerm) !== -1;
      }
      n.style.display = visible ? '' : 'none';
    }
  }

  function append(row) {
    if (!row) return;
    if (empty) { empty.remove(); empty = null; }
    if (paused) {
      deferred.push(function () { log.appendChild(row); });
      return;
    }
    log.appendChild(row);
    total++;
    countEl.textContent = total + ' events';
    if (stick) scrollBottom();
  }

  function handle(evt) {
    if (evt.type === 'session') {
      startTs = evt.connectedAt || Date.now();
      var s = evt.session;
      var sess = document.getElementById('session');
      if (s && (s.name || s.model || s.id)) {
        var parts = [];
        if (s.name) parts.push(s.name);
        if (s.model) parts.push(s.model);
        if (s.id) parts.push(s.id);
        sess.innerHTML = 'session: <b>' + escapeHtml(parts.join(' · ')) + '</b>';
      }
      return;
    }
    if (evt.type === 'context') {
      updateCtxBar(evt);
      return;
    }
    if (RENDER[evt.type]) {
      var row = RENDER[evt.type](evt);
      if (evt.type === 'tool_start' && evt.toolCallId) {
        openTools[evt.toolCallId] = row;
      }
      append(row);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // elapsed timer
  setInterval(function () {
    var sec = Math.floor((Date.now() - startTs) / 1000);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    document.getElementById('elapsed').textContent =
      (h ? h + 'h ' : '') + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }, 1000);

  // SSE
  function connect() {
    var es = new EventSource('/events');
    var status = document.getElementById('status');
    var dot = document.getElementById('dot');

    es.onopen = function () {
      status.textContent = 'live';
      status.className = 'live';
      dot.className = 'dot live';
    };
    es.onerror = function () {
      status.textContent = 'reconnecting…';
      status.className = 'bad';
      dot.className = 'dot dead';
    };
    es.addEventListener('session', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('system', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('tool_start', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('tool_end', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('llm_start', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('llm_end', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('phase', function (e) { handle(JSON.parse(e.data)); });
    // NB: error is also a built-in EventSource event (connection failures,
    // which carry no data). Guard so those can't blow up the parser.
    es.addEventListener('error', function (e) { if (e.data) handle(JSON.parse(e.data)); });
    es.addEventListener('text', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('meta', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('context', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('compaction', function (e) { handle(JSON.parse(e.data)); });
  }

  connect();
})();
</script>
</body>
</html>`;