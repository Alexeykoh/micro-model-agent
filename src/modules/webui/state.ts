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
  busy: boolean;
  lastPostTs: number;
  minPostIntervalMs: number;
  historyTail: number;
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
    lastPostTs: 0,
    minPostIntervalMs: 500,
    historyTail: 200,
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
    try {
      client.write(payload);
    } catch {
      s.clients.delete(client);
    }
  }
}
