import type { LspConfig, LspServerConfig } from "./types";
import { LspClient } from "./client";
import { getLanguageForFile } from "./config";
import { collectCheckFiles } from "./check-tool";
import { findProjectRoot } from "./project-root";

/**
 * Probe result for one server: which language it covers and whether the
 * server actually started (spawn + initialize succeeded).
 */
export interface LspProbeResult {
  language: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

/** Probe results for the servers applicable to a project. */
export interface LspProbeSummary {
  /** Servers that started successfully. */
  ok: LspProbeResult[];
  /** Servers that failed to start. */
  failed: LspProbeResult[];
  /** True when no LSP server applies to the project's files. */
  noneApplicable: boolean;
}

export interface LspProbeDeps {
  client?: LspClient;
  /** Override the per-server probe timeout cap in ms. */
  timeoutMs?: number;
  /** Overall probe deadline in ms (bounds the banner for broken servers). */
  deadlineMs?: number;
  /** Injectable file collector (tests). */
  collectFiles?: (baseDir: string, config: LspConfig) => Promise<string[]>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_DEADLINE_MS = 60_000;

/**
 * Check which LSP servers apply to the project (via the same bounded file
 * walk as lsp_check) and probe each one: spawn + initialize + shutdown.
 * Used by the REPL banner so a dead server is visible before the first write.
 */
export async function probeLspServers(
  config: LspConfig,
  baseDir: string,
  deps: LspProbeDeps = {},
): Promise<LspProbeSummary> {
  if (!config.enabled) return { ok: [], failed: [], noneApplicable: true };

  const client = deps.client ?? new LspClient();
  const timeoutCap = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS;
  const collect = deps.collectFiles ?? collectCheckFiles;

  const files = await collect(baseDir, config);
  const seen = new Set<string>();
  const servers: Array<{ language: string; config: LspServerConfig }> = [];
  for (const file of files) {
    const language = getLanguageForFile(file);
    if (!language) continue;
    const server = config.servers[language];
    if (!server || seen.has(language)) continue;
    seen.add(language);
    servers.push({ language, config: server });
  }

  if (servers.length === 0) return { ok: [], failed: [], noneApplicable: true };

  // Sequential probing: npx auto-install downloads into a shared cache, so
  // probing several servers in parallel makes them fight over the cache lock —
  // observed as `LSP request timeout: initialize` for half the servers on a
  // cold cache. One at a time, each server gets its own config timeout (capped
  // so a hung server can't stall the REPL banner for minutes).
  const ok: LspProbeResult[] = [];
  const failed: LspProbeResult[] = [];
  const deadline = Date.now() + deadlineMs;

  for (const { language, config: server } of servers) {
    if (Date.now() >= deadline) {
      failed.push({
        language,
        ok: false,
        error: "timeout",
        durationMs: 0,
      });
      continue;
    }
    const projectRoot = findProjectRoot(baseDir, baseDir, server.workspaceMarkers ?? []);
    const serverTimeout = Math.min(server.timeout ?? timeoutCap, timeoutCap);
    const started = Date.now();
    try {
      await client.probe(server, projectRoot, serverTimeout);
      ok.push({ language, ok: true, durationMs: Date.now() - started });
    } catch (e) {
      failed.push({
        language,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - started,
      });
    }
  }

  return { ok, failed, noneApplicable: false };
}
