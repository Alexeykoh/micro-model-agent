/**
 * Shared mutable state for the trace-server plugin.
 *
 * The plugin can be loaded twice in one process (global + project dirs), which
 * would start two servers. All mutable state lives in a process-global object
 * keyed by a symbol, so any number of loaded instances share one server and
 * one client set.
 */
import type { Server, ServerResponse } from "node:http";

export interface SessionMetaLike {
  id?: string;
  name?: string;
  model?: string;
  messageCount?: number;
  contextWindow?: number;
  projectDir?: string;
}

export interface ContextBudgetLike {
  systemPrompt: number;
  responseReserve: number;
  history: number;
}

export interface ContextSnapshot {
  tokens: number;
  budget: ContextBudgetLike;
  quality: number;
  compactionCount: number;
  iterationsSinceCompaction: number;
  messageCount: number;
}

export interface PlanHistoryEntry {
  ts: number;
  kind: string;
  title: string;
  done: number;
  total: number;
  detail: string;
}

export interface TraceState {
  server: Server | null;
  clients: Set<ServerResponse>;
  traceUrl: string;
  sessionMeta: SessionMetaLike | null;
  /** Detaches the output-bus subscription registered at session start. */
  outputUnsub: (() => void) | null;
  pending: { type: "text" | "meta"; text: string; iteration?: number } | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  llmStartTs: number | null;
  /** Last seen compaction count — used to detect new compactions. */
  lastCompactionCount: number;
  /** Context snapshot emitted before the previous event, for delta display. */
  lastContext: ContextSnapshot | null;
  /** Rendered text of the current context (for the right-hand panel). */
  contextText: string;
  /** Timestamp of the last context_text broadcast (throttle). */
  lastTextTs: number;
  /** Full text of the last broadcast context_text — dedupe identical. */
  lastTextBody: string;
  /** Working dir of the session — plans are read from <project>/.mma/plans/. */
  projectDir: string | null;
  /** Last seen plan store JSON — detect plan changes. */
  lastPlansKey: string;
  /** Accumulated plan history (activity feed, newest first). */
  planHistory: PlanHistoryEntry[];
  planTimer: ReturnType<typeof setInterval> | null;
  /** In-flight startServer() promise — dedupes concurrent starts (the plugin
   * loads twice: global + project dirs; both onSessionStart hooks fire in the
   * same synchronous tick, before the first listen() callback sets `server`). */
  starting: Promise<string> | null;
}

export const HOST = process.env.MMA_TRACE_HOST || "127.0.0.1";
export const MAX_CLIENTS = Math.max(1, Number(process.env.MMA_TRACE_MAX_CLIENTS) || 5);

const G = globalThis as unknown as Record<symbol, TraceState>;
const KEY = Symbol.for("mma.trace-server");

export const state: TraceState =
  G[KEY] ||
  (G[KEY] = {
    server: null,
    clients: new Set<ServerResponse>(),
    traceUrl: "",
    sessionMeta: null,
    outputUnsub: null,
    pending: null,
    flushTimer: null,
    llmStartTs: null,
    lastCompactionCount: 0,
    lastContext: null,
    contextText: "",
    lastTextTs: 0,
    lastTextBody: "",
    projectDir: null,
    lastPlansKey: "",
    planHistory: [],
    planTimer: null,
    starting: null,
  });

export function broadcast(evt: Record<string, unknown>): void {
  const frame = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const client of state.clients) {
    try {
      client.write(frame);
    } catch {
      state.clients.delete(client);
    }
  }
}

export function pushChunk(type: "text" | "meta", chunk: string, iteration?: number): void {
  if (!chunk) return;
  if (state.pending && state.pending.type !== type) flush();
  state.pending =
    state.pending && state.pending.type === type
      ? { type, text: state.pending.text + chunk, iteration: iteration ?? state.pending.iteration }
      : { type, text: chunk, iteration };
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.flushTimer = setTimeout(flush, 350);
}

export function flush(): void {
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
