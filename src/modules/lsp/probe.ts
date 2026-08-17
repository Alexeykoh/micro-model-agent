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
  /** Per-server probe timeout in ms. */
  timeoutMs?: number;
  /** Injectable file collector (tests). */
  collectFiles?: (baseDir: string, config: LspConfig) => Promise<string[]>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

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
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
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

  const results = await Promise.all(
    servers.map(async ({ language, config: server }) => {
      const projectRoot = findProjectRoot(baseDir, baseDir, server.workspaceMarkers ?? []);
      const started = Date.now();
      try {
        await client.probe(server, projectRoot, timeoutMs);
        return { language, ok: true, durationMs: Date.now() - started };
      } catch (e) {
        return {
          language,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - started,
        };
      }
    }),
  );

  return {
    ok: results.filter((r) => r.ok),
    failed: results.filter((r) => !r.ok),
    noneApplicable: false,
  };
}
