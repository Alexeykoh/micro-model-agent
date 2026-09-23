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
import { MAX_BODY_BYTES } from "./util";

export interface WebUiAssets {
  html: string;
  css: string;
  js: string;
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
