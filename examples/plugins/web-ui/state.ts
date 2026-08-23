/**
 * Shared mutable state for the web-ui plugin.
 *
 * The plugin can be loaded twice in one process (global + project dirs), so
 * all mutable state lives in a process-global object keyed by a symbol — any
 * number of loaded instances share one server and one client set (same
 * pattern as trace-server).
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

/** Duck-typed against HostBridge in src/modules/types.ts. */
export interface BridgeLike {
  isBusy(): boolean;
  submit(text: string, opts?: { images?: string[] }): Promise<unknown>;
  interrupt(): void;
}

export interface WebUiState {
  server: Server | null;
  clients: Set<ServerResponse>;
  url: string;
  /** In-flight startServer() promise — dedupes concurrent starts. */
  starting: Promise<string> | null;
  sessionMeta: SessionMetaLike | null;
  /** Working dir of the session — plans are read from <project>/.mma/plans/. */
  projectDir: string | null;
  /** MMA config dir (~/.mma) — history is read from <configDir>/sessions/<id>/history.jsonl. */
  configDir: string | null;
  bridge: BridgeLike | null;
  /** True between an accepted submit and turn_end. */
  busy: boolean;
  llmStartTs: number | null;
  lastPlansKey: string;
  pending: { type: "text" | "meta"; text: string; iteration?: number } | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Rate limit for POST /api/message (ms); injectable/0 disables — tests. */
  minPostIntervalMs: number;
  lastPostTs: number;
  /** How many history messages to backfill on GET /api/state. */
  historyTail: number;
}

export const HOST = process.env.MMA_WEBUI_HOST || "127.0.0.1";
export const MAX_CLIENTS = Math.max(1, Number(process.env.MMA_WEBUI_MAX_CLIENTS) || 5);
export const MAX_MESSAGE_CHARS = 32_000;
export const MAX_IMAGES = 3;

const G = globalThis as unknown as Record<symbol, WebUiState>;
const KEY = Symbol.for("mma.web-ui");

function freshState(): WebUiState {
  return {
    server: null,
    clients: new Set<ServerResponse>(),
    url: "",
    starting: null,
    sessionMeta: null,
    projectDir: null,
    configDir: null,
    bridge: null,
    busy: false,
    llmStartTs: null,
    lastPlansKey: "",
    pending: null,
    flushTimer: null,
    minPostIntervalMs: Number(process.env.MMA_WEBUI_MIN_INTERVAL_MS ?? 500),
    lastPostTs: 0,
    historyTail: 30,
  };
}

export const state: WebUiState = G[KEY] || (G[KEY] = freshState());

/** Test helper: return a fresh isolated state object (not the global one). */
export function createStateForTests(): WebUiState {
  const s = freshState();
  s.minPostIntervalMs = 0;
  return s;
}

export function broadcast(
  evt: Record<string, unknown>,
  s: WebUiState = state,
  clients?: Set<ServerResponse>,
): void {
  const target = clients ?? s.clients;
  const frame = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const client of target) {
    try {
      client.write(frame);
    } catch {
      target.delete(client);
    }
  }
}

export function pushChunk(
  type: "text" | "meta",
  chunk: string,
  iteration?: number,
  s: WebUiState = state,
): void {
  if (!chunk) return;
  if (s.pending && s.pending.type !== type) flush(s);
  s.pending =
    s.pending && s.pending.type === type
      ? { type, text: s.pending.text + chunk, iteration: iteration ?? s.pending.iteration }
      : { type, text: chunk, iteration };
  if (s.flushTimer) clearTimeout(s.flushTimer);
  s.flushTimer = setTimeout(() => flush(s), 350);
}

export function flush(s: WebUiState = state): void {
  if (s.flushTimer) {
    clearTimeout(s.flushTimer);
    s.flushTimer = null;
  }
  if (s.pending) {
    const p = s.pending;
    s.pending = null;
    broadcast({ type: p.type, ts: Date.now(), iteration: p.iteration, text: p.text }, s);
  }
}
