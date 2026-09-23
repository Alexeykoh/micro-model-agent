/**
 * Shared mutable state for the `mma web` module.
 *
 * Mirrors the proven web-ui plugin state shape but stays transport-focused:
 * no session meta, plans or history here (those arrive in later tasks). The
 * server holds an explicit `WebUiState` so tests can run hermetically against a
 * fresh object instead of the process-global default.
 */
import type { Server, ServerResponse } from "node:http";
import type { Host } from "../../core/host";
import type { AppConfig } from "../../config/types";
import type { SessionMeta, SessionMessage } from "../../modules/session/types";
import type { SessionLogEntry } from "../../modules/session/store";
import type { MemoryStore } from "../memory/store";
import { MAX_BODY_BYTES } from "./util";

/**
 * Structural subset of `SessionManager` the web REST surface needs. Keeping it
 * narrow lets the real manager satisfy it implicitly while tests stub it
 * without casts. The history readers are optional so lightweight stubs that
 * only exercise list/activate/delete stay valid; the history endpoint answers
 * with an empty transcript when neither is implemented.
 */
export interface WebSessionManager {
  list(): SessionMeta[];
  get(id: string): SessionMeta | null;
  getActive(): string | null;
  setActive(id: string): void;
  delete(id: string): void;
  loadSessionLog?(id: string): SessionLogEntry[];
  getHistory?(id: string): SessionMessage[];
}

export interface WebUiAssets {
  html: string;
  css: string;
  js: string;
}

/**
 * Last-turn usage metrics captured from `AgentResult` and surfaced through
 * `HostStateSnapshot`. All fields are optional: a turn that did not report a
 * value leaves the corresponding sidebar cell at `—`.
 */
export interface UsageSnapshot {
  contextUsed?: number;
  contextLimit?: number;
  costUsd?: number;
  compactionCount?: number;
  cacheHitRate?: number;
  cacheSaved?: number;
  contextQuality?: number;
}

export interface WebUiState {
  server: Server | null;
  starting: Promise<string> | null;
  url: string;
  host: string;
  token: string | null;
  clients: Set<ServerResponse>;
  bridge: Host | null;
  /**
   * Single-flight reservation for the UI (`/api/message`). Owned by the server:
   * set synchronously when a submit is accepted and reset by the forwarder's
   * `turn_end` (or by {@link releaseBusy} if the turn never started).
   */
  busy: boolean;
  /**
   * Whether an agent turn is actually executing. Kept separate from {@link busy}
   * so `WebHost.submit`'s own `isBusy()` guard is NOT tripped by the server's
   * reservation (which happens before `submit` is invoked). Set when `runAgent`
   * starts, reset by the forwarder's `turn_end`.
   */
  agentRunning: boolean;
  /** Ownership token for {@link busy}; see {@link reserveBusy}/{@link releaseBusy}. */
  turnToken: object | null;
  lastPostTs: number;
  minPostIntervalMs: number;
  historyTail: number;
  /** Transport cap for a POST body; overridable in tests to exercise 413. */
  maxBodyBytes: number;
  /** Usage metrics from the most recent completed turn (see {@link UsageSnapshot}). */
  usage?: UsageSnapshot;
  /**
   * Bootstrap collaborators for the config/session/model REST surface. Wired by
   * `module.ts`; optional so tests can drive individual endpoints in isolation
   * (a missing one yields 503, never a crash).
   */
  config?: AppConfig;
  sessionManager?: WebSessionManager;
  saveConfig?: (config: AppConfig) => void;
  reconfigure?: (config: AppConfig) => void | Promise<void>;
  knownModels?: () => string[];
  /**
   * Global memory store, shared with the agent (`bootstrap` owns one instance).
   * Wired by `module.ts`; optional so tests can drive command dispatch without
   * touching the filesystem — `/memory` then answers "unavailable".
   */
  memory?: MemoryStore;
}

export function createWebUiState(): WebUiState {
  return {
    server: null,
    starting: null,
    url: "",
    host: process.env.MMA_WEBUI_HOST || "127.0.0.1",
    token: process.env.MMA_WEBUI_TOKEN || null,
    clients: new Set(),
    bridge: null,
    busy: false,
    agentRunning: false,
    turnToken: null,
    lastPostTs: 0,
    minPostIntervalMs: 500,
    historyTail: 200,
    maxBodyBytes: MAX_BODY_BYTES,
  };
}

export interface SseEvent {
  type: string;
  ts: number;
  [k: string]: unknown;
}

export function broadcast(ev: SseEvent, s: WebUiState): void {
  const payload = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const client of s.clients) {
    // Backpressure: a `false` return means the socket buffer is full (slow or
    // stalled reader). Drop the client rather than buffering events unboundedly.
    try {
      if (!client.write(payload)) {
        s.clients.delete(client);
        client.end();
      }
    } catch {
      s.clients.delete(client);
    }
  }
}

/**
 * Atomically reserve the single-flight slot and return its ownership token.
 *
 * MUST be called synchronously in the same tick as the busy pre-check: any
 * `await` between check and reserve lets two concurrent submits both win. The
 * token makes the reset owner explicit — a late failure callback from a
 * previous turn can never clear a newer turn's reservation.
 */
export function reserveBusy(s: WebUiState): object {
  const token = {};
  s.turnToken = token;
  s.busy = true;
  return token;
}

/**
 * Release the slot only if `token` still owns it. Returns whether the caller
 * was the owner (so it can skip a duplicate `state` broadcast when the
 * forwarder's `turn_end` already reset the flag).
 */
export function releaseBusy(s: WebUiState, token: object): boolean {
  if (s.turnToken !== token) return false;
  s.turnToken = null;
  s.busy = false;
  return true;
}
