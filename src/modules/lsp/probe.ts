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
  /**
   * How many servers to probe concurrently. Sequential (1) is safest on a cold
   * npx cache (see below); a higher value keeps the REPL banner fast once the
   * cache is warm. Each server in a wave uses its own LspClient (the client is
   * stateful, so concurrent probes on a shared instance would corrupt each
   * other's request/response state).
   */
  maxParallel?: number;
  /** Injectable file collector (tests). */
  collectFiles?: (baseDir: string, config: LspConfig) => Promise<string[]>;
  /** Logger for error reporting. */
  logger?: { debug(msg: string, meta?: Record<string, unknown>): void; info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void; error(msg: string, meta?: Record<string, unknown>): void };
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_DEADLINE_MS = 60_000;
const DEFAULT_MAX_PARALLEL = 3;

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

  const timeoutCap = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS;
  const maxParallel = deps.maxParallel ?? DEFAULT_MAX_PARALLEL;
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

  // Probe in bounded waves. Probing everything in parallel on a cold npx cache
  // makes the servers fight over the shared cache lock — observed as `LSP
  // request timeout: initialize` for half the servers. Fully sequential probing
  // avoids that but doubles the REPL banner wait (each server ~2s). A wave of
  // `maxParallel` keeps the banner fast on a warm cache while capping cold-cache
  // contention; each server in a wave gets its own LspClient (the client is
  // stateful — process, request ids, response buffer — so concurrent probes on
  // a shared instance would cross-talk). When a client is injected (tests), it
  // is reused for every server.
  const ok: LspProbeResult[] = [];
  const failed: LspProbeResult[] = [];
  const deadline = Date.now() + deadlineMs;

  const probeOne = async (language: string, server: LspServerConfig): Promise<void> => {
    const projectRoot = findProjectRoot(baseDir, baseDir, server.workspaceMarkers ?? []);
    const serverTimeout = Math.min(server.timeout ?? timeoutCap, timeoutCap);
    const started = Date.now();
    const probeClient = deps.client ?? new LspClient();
    if (!deps.client) probeClient.setLogger(deps.logger ?? null);
    try {
      await probeClient.probe(server, projectRoot, serverTimeout);
      ok.push({ language, ok: true, durationMs: Date.now() - started });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      deps.logger?.warn(`LSP probe failed for ${language}: ${errorMsg}`, {
        command: server.command,
        timeout: serverTimeout,
        durationMs: Date.now() - started,
      });
      failed.push({
        language,
        ok: false,
        error: errorMsg,
        durationMs: Date.now() - started,
      });
    }
  };

  for (let i = 0; i < servers.length; i += maxParallel) {
    if (Date.now() >= deadline) {
      const remaining = servers.slice(i).map((s) => s.language);
      deps.logger?.warn(`LSP probe deadline reached, skipping: ${remaining.join(", ")}`);
      for (const { language } of servers.slice(i)) {
        failed.push({ language, ok: false, error: "timeout", durationMs: 0 });
      }
      break;
    }
    const wave = servers.slice(i, i + maxParallel);
    await Promise.all(wave.map(({ language, config: server }) => probeOne(language, server)));
  }

  return { ok, failed, noneApplicable: false };
}
