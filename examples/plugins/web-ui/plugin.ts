/**
 * web-ui — bidirectional chat interface for MMA in the browser.
 *
 * Zero-dependency folder plugin, sibling of trace-server:
 *   plugin.ts     entry — hooks into the agent loop, wires the modules below
 *   state.ts      process-global shared state + SSE broadcast primitives
 *   util.ts       clipping / arg summaries / secret scrubbing / validation
 *   history.ts    history.jsonl tail for page (re)load backfill
 *   plans-snap.ts on-disk plan reading + 2s change poll
 *   server.ts     HTTP + SSE + REST (/api/state, /api/message, /api/interrupt)
 *   page.html     frontend markup (served verbatim from disk)
 *   styles.css    frontend theme
 *   app.js        frontend SSE + rendering + input logic
 *
 * Messages submitted from the browser go through the SAME Repl.runAgent path
 * as terminal input via the HostBridge (`ctx.hostBridge`), so rendering,
 * session logging and the single-flight guard are shared with the terminal.
 *
 * Install (folder plugin — copy the whole folder):
 *   Windows:  copy the web-ui folder to %USERPROFILE%\.mma\plugins\
 *   POSIX:    copy to ~/.mma/plugins/ or <project>/.mma/plugins/
 * Restart `mma`, open the URL printed at session start ("web ui → …").
 *
 * Config (env):
 *   MMA_WEBUI_PORT          fixed port (default 0 = random free port)
 *   MMA_WEBUI_HOST          bind address (default 127.0.0.1 — localhost only)
 *   MMA_WEBUI_TOKEN         require this token on /api/* (mandatory for
 *                           non-loopback binds)
 *   MMA_WEBUI_MAX_CLIENTS   SSE client cap (default 5)
 *   MMA_WEBUI_OPEN          "0" disables auto-opening the browser at start
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { state, broadcast, pushChunk, flush, type WebUiState } from "./state";
import { clip, safeJson, summarizeArgs, scrub } from "./util";
import { emitPlans, startPlanPolling, stopPlanPolling } from "./plans-snap";
import { startServer, stopServer, tryOpenBrowser } from "./server";
import type { WebUiAssets } from "./server";

// ---- per-tool output caps for SSE broadcast ----

const TOOL_OUTPUT_CAPS: Record<string, number> = {
  browser: 8000,
  web_search: 6000,
  web_fetch: 4000,
  web_browse: 4000,
  bash: 16000,
  read_file: 12000,
  list_dir: 4000,
  grep: 4000,
  glob: 2000,
  download_file: 2000,
};
const DEFAULT_OUTPUT_CAP = 6000;

function clipToolOutput(toolName: string, output: string): string {
  const cap = TOOL_OUTPUT_CAPS[toolName] ?? DEFAULT_OUTPUT_CAP;
  if (output.length <= cap) return output;
  return output.slice(0, cap) + `\n… [truncated from ${output.length.toLocaleString()} chars]`;
}

// ---- minimal structural types (duck-typed against core) ----

interface ToolCallLike {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
interface ToolResultLike {
  success: boolean;
  output: string;
  display?: string;
}
interface TurnSummaryLike {
  success: boolean;
  durationMs?: number;
  textLength?: number;
  toolCalls?: number;
  interrupted?: boolean;
}
interface LLMResponseLike {
  type?: string;
  content?: string;
  calls?: ToolCallLike[];
}
interface PluginContextLike {
  logger?: { info(msg: string): void; warn(msg: string): void };
  sessionManager?: SessionMetaLike & { projectDir?: string };
  contextManager?: Record<string, unknown> & { getSnapshot?: () => ContextSnapshotLike | null };
  hostBridge?: BridgeLike;
  iteration?: number;
  lastUserMessage?: string;
}
interface SessionMetaLike {
  id?: string;
  name?: string;
  model?: string;
}
interface ContextSnapshotLike {
  tokens?: number;
  quality?: number;
  messageCount?: number;
  compactionCount?: number;
}
interface BridgeLike {
  isBusy(): boolean;
  submit(text: string, opts?: { images?: string[] }): Promise<unknown>;
  interrupt(): void;
}

// ---- frontend assets (read verbatim at load time) ----

const here = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR_CANDIDATES = [
  here,
  join(here, "web-ui"),
  join(here, "dist", "examples", "plugins", "web-ui"),
];
const ASSET_DIR = ASSET_DIR_CANDIDATES.find((d) => existsSync(join(d, "page.html")));

function readAsset(name: string, fallback: string): string {
  if (!ASSET_DIR) return fallback;
  const p = join(ASSET_DIR, name);
  return existsSync(p) ? readFileSync(p, "utf8") : fallback;
}

const ASSETS: WebUiAssets = {
  html: readAsset("page.html", "web-ui: page.html not found"),
  css: readAsset("styles.css", "/* web-ui: styles.css not found */"),
  js: readAsset("app.js", "// web-ui: app.js not found"),
};

/** Capture everything handlers need from a hook ctx onto the state object. */
function syncState(ctx: PluginContextLike): void {
  state.sessionMeta = ctx.sessionManager || null;
  state.projectDir = ctx.sessionManager?.projectDir || null;
  // History lives at <configDir>/sessions/<id>/history.jsonl (SessionStore
  // layout). MMA_WEBUI_CONFIG_DIR overrides the default ~/.mma (tests/sandboxes).
  state.configDir = process.env.MMA_WEBUI_CONFIG_DIR || join(homedir(), ".mma");
  state.bridge = ctx.hostBridge ?? null;
}

export const plugin = {
  name: "web-ui",
  version: "0.1.0",
  minMmaVersion: "0.51.0",
  priority: 100,

  onSessionStart(ctx: PluginContextLike): void {
    state.lastPlansKey = "";
    syncState(ctx);
    startServer(ASSETS, state)
      .then((url) => {
        broadcast({ type: "system", ts: Date.now(), message: `Web UI ready: ${url}` }, state);
        broadcast(
          { type: "session", ts: Date.now(), session: state.sessionMeta, url, busy: state.busy },
          state,
        );
        emitPlans("session-start");
        startPlanPolling(state);
        ctx.logger?.info(`[web-ui] live chat → ${url}`);
        tryOpenBrowser(url);
      })
      .catch((err: Error) => {
        ctx.logger?.warn(`[web-ui] failed to start: ${err?.message || String(err)}`);
      });
  },

  onSessionEnd(): void {
    broadcast({ type: "system", ts: Date.now(), message: "Session ended — server closing" }, state);
    stopPlanPolling();
    stopServer(state);
  },

  onPhase(_ctx: PluginContextLike, phase: string): void {
    flush();
    broadcast({ type: "phase", ts: Date.now(), phase }, state);
  },

  onBeforeThink(ctx: PluginContextLike): void {
    flush();
    const snap = ctx.contextManager?.getSnapshot?.() ?? null;
    if (snap) {
      broadcast(
        {
          type: "context",
          ts: Date.now(),
          tokens: snap.tokens ?? 0,
          quality: snap.quality ?? 100,
          messageCount: snap.messageCount ?? 0,
          compactionCount: snap.compactionCount ?? 0,
        },
        state,
      );
    }
    state.llmStartTs = Date.now();
    broadcast(
      {
        type: "llm_start",
        ts: Date.now(),
        iteration: ctx.iteration,
        task: ctx.lastUserMessage ? scrub(clip(ctx.lastUserMessage, 300)) : null,
      },
      state,
    );
  },

  onAfterThink(ctx: PluginContextLike, response: LLMResponseLike | null): void {
    flush();
    const durationMs = state.llmStartTs !== null ? Date.now() - state.llmStartTs : undefined;
    state.llmStartTs = null;
    broadcast(
      {
        type: "llm_end",
        ts: Date.now(),
        iteration: ctx.iteration,
        kind: response?.type || null,
        callCount: response?.calls?.length || 0,
        durationMs,
      },
      state,
    );
  },

  onToolStart(ctx: PluginContextLike, call: ToolCallLike): void {
    flush();
    broadcast(
      {
        type: "tool_start",
        ts: Date.now(),
        iteration: ctx.iteration,
        toolCallId: call.id,
        name: call.name,
        args: scrub(safeJson(call.arguments)),
        summary: scrub(summarizeArgs(call.arguments)),
      },
      state,
    );
  },

  onToolEnd(
    ctx: PluginContextLike,
    call: ToolCallLike,
    result: ToolResultLike,
    durationMs: number,
  ): void {
    flush();
    if (call.name === "plan" || call.name === "todo") emitPlans(call.name);
    broadcast(
      {
        type: "tool_end",
        ts: Date.now(),
        iteration: ctx.iteration,
        toolCallId: call.id,
        name: call.name,
        success: result.success,
        durationMs,
        output: scrub(clipToolOutput(call.name, result.output || "")),
      },
      state,
    );
  },

  onError(ctx: PluginContextLike, err: Error): void {
    flush();
    broadcast(
      {
        type: "error",
        ts: Date.now(),
        iteration: ctx.iteration,
        message: scrub(err?.message || String(err)),
        stack: err?.stack ? scrub(clip(err.stack, 5000)) : undefined,
      },
      state,
    );
  },

  onText(ctx: PluginContextLike, chunk: string): void {
    pushChunk("text", chunk, ctx.iteration);
  },

  onMeta(ctx: PluginContextLike, chunk: string): void {
    pushChunk("meta", chunk, ctx.iteration);
  },

  onTurnEnd(_ctx: PluginContextLike, summary: TurnSummaryLike): void {
    state.busy = false;
    broadcast({ type: "turn_end", ts: Date.now(), ...summary }, state);
  },
};
