/**
 * trace-server — live agent-loop trace in the browser.
 *
 * Zero-dependency example plugin, split into a folder:
 *   plugin.ts   entry — hooks into the agent loop, wires the modules below
 *   state.ts    process-global shared state + SSE broadcast primitives
 *   util.ts     clipping / arg summaries / secret scrubbing
 *   context.ts  context snapshots + conversation-history text rendering
 *   plans.ts    on-disk plan reading + broadcasting + 2s poll
 *   server.ts   HTTP + SSE server
 *   page.html   frontend markup (served verbatim from disk)
 *   styles.css  frontend theme
 *   app.js      frontend SSE + rendering logic
 *
 * The plugin starts a local HTTP server when the agent session starts and
 * streams every loop event to the browser over SSE: phases (thinking
 * spinner), LLM calls (with task, timing, tool-call list), tool start/end
 * with full args/results and a compact arg summary, errors (with stack),
 * streamed text/reasoning, context snapshots + full conversation text, and
 * the agent's plans (current, all, and an activity feed).
 *
 * Install (folder plugin — copy the whole folder):
 *   Windows:  copy the trace-server folder to %USERPROFILE%\.mma\plugins\
 *   POSIX:    copy the trace-server folder to ~/.mma/plugins/
 *   Project:  <project>/.mma/plugins/trace-server/
 * Restart `mma`, open the URL printed at session start ("live trace → …").
 *
 * Config (env):
 *   MMA_TRACE_PORT         fixed port (default 0 = random free port)
 *   MMA_TRACE_HOST         bind address (default 127.0.0.1 — localhost only)
 *   MMA_TRACE_MAX_CLIENTS  SSE client cap (default 5)
 *   MMA_TRACE_OPEN         "0" disables auto-opening the browser at start
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { state, broadcast, flush, pushChunk } from "./state";
import { clip, safeJson, summarizeArgs, scrub } from "./util";
import { emitContext, emitContextText } from "./context";
import type { PluginContext } from "./context";
import { emitPlans, startPlanPolling } from "./plans";
import { startServer, stopServer, tryOpenBrowser } from "./server";

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
interface LLMResponseLike {
  type?: string;
  content?: string;
  calls?: ToolCallLike[];
}

// ---- frontend assets ----
//
// Read at load time, verbatim. `import.meta.url` resolves against the plugin
// folder whether it runs from source (examples/) or an installed copy
// (~/.mma/plugins/trace-server/ or <project>/.mma/plugins/trace-server/).
const here = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR_CANDIDATES = [
  here,
  join(here, "trace-server"),
  join(here, "dist", "examples", "plugins", "trace-server"),
];
const ASSET_DIR = ASSET_DIR_CANDIDATES.find((d) => existsSync(join(d, "page.html")));

function readAsset(name: string, fallback: string): string {
  if (!ASSET_DIR) return fallback;
  const p = join(ASSET_DIR, name);
  return existsSync(p) ? readFileSync(p, "utf8") : fallback;
}

const ASSETS = {
  html: readAsset("page.html", "trace-server: page.html not found"),
  css: readAsset("styles.css", "/* trace-server: styles.css not found */"),
  js: readAsset("app.js", "// trace-server: app.js not found"),
};

export const plugin = {
  name: "trace-server",
  version: "0.1.0",
  minMmaVersion: "0.36.0",
  priority: 100,

  onSessionStart(ctx: PluginContext): void {
    state.sessionMeta = ctx.sessionManager || null;
    state.lastCompactionCount = 0;
    state.lastContext = null;
    state.lastTextBody = "";
    state.contextText = "";
    state.projectDir = (ctx.sessionManager as { projectDir?: string } | null)?.projectDir || null;
    state.lastPlansKey = "";
    state.planHistory = [];
    startServer(ASSETS)
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
        // Prime the side panel: current context text + plans + poll loop.
        emitContext(ctx);
        emitContextText(ctx);
        emitPlans("session-start");
        startPlanPolling();
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
    emitContextText(ctx);
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
    emitContextText(ctx);
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
    emitContextText(ctx);
    if (call.name === "plan" || call.name === "todo") emitPlans(call.name);
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