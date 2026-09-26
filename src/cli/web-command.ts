/**
 * `mma web` entry point: bootstrap, start the browser UI, keep the process alive
 * until SIGINT/SIGTERM, then shut down cleanly.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bootstrap } from "../core/bootstrap";
import { agentsMdPaths } from "../core/bootstrap";
import { getDefaultChannel } from "../output";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { startWebUi } from "../modules/webui/module";
import { tryOpenBrowser } from "../modules/webui/server";
import { globalMmaDir } from "../config/paths";

export interface WebCommandOptions {
  port?: number;
  host?: string;
  token?: string;
  noOpen?: boolean;
  projectDir?: string;
  noAgentsMd?: boolean;
}

/**
 * Parse and validate the `--port` flag. `undefined`/blank → `undefined` (random
 * port). Non-numeric and out-of-range values throw instead of silently falling
 * back to a random port, so `--port abc` cannot masquerade as a working bind.
 */
export function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`invalid --port "${raw}": expected an integer between 1 and 65535`);
  }
  return n;
}

/**
 * Bootstrap arguments used by `runWeb`. Extracted so the CLI-flag forwarding
 * (notably `--no-agents-md`) is unit-testable without booting the real agent —
 * Bun module mocks are process-global, so a spy on `bootstrap` would leak.
 */
export function webBootstrapArgs(
  opts: WebCommandOptions,
): [undefined, string | undefined, boolean | undefined, true] {
  return [undefined, opts.projectDir, opts.noAgentsMd, true];
}

export async function runWeb(opts: WebCommandOptions): Promise<void> {
  // The transport reads these at startup (server/state): port has no config
  // field, so the CLI flag maps onto the env var the server already honours.
  if (opts.port !== undefined) process.env.MMA_WEBUI_PORT = String(opts.port);
  if (opts.host) process.env.MMA_WEBUI_HOST = opts.host;
  if (opts.token) process.env.MMA_WEBUI_TOKEN = opts.token;
  if (opts.noOpen) process.env.MMA_WEBUI_OPEN = "0";

  const mmaDir = globalMmaDir();
  const { hasDomainFiles } = await import("../config/domains");
  const virgin = !existsSync(join(mmaDir, "config.json")) && !hasDomainFiles(mmaDir);

  // exitOnComplete=true: no interactive prompt owns stdin in web mode.
  const {
    agent,
    config,
    sessionManager,
    execModule,
    configDir,
    baseDir,
    noAgentsMd,
    indexerModule,
    memoryStore,
    skillsModule,
    pluginManager,
    toolRegistry,
    toolCtx,
    contextProbe,
  } = await bootstrap(...webBootstrapArgs(opts));

  if (virgin) {
    getDefaultChannel().writeLine(pc.yellow(`  ${t("cli.web_setup_required")}`), "stderr");
  }

  const web = await startWebUi({
    agent,
    config,
    sessionManager,
    execModule,
    memory: memoryStore,
    skills: skillsModule,
    plugins: pluginManager,
    toolRegistry,
    toolCtx,
    configDir,
    baseDir,
    agentsMd: {
      disabled: noAgentsMd,
      files: noAgentsMd ? [] : agentsMdPaths(baseDir, configDir).filter((p) => existsSync(p)),
    },
    indexer: indexerModule,
    contextProbe,
    host: opts.host,
    token: opts.token,
    setupRequired: virgin,
  });

  const url = await web.url;
  // Always show the resolved workspace: a shell-split `-d` path (spaces,
  // trailing backslash) can silently point somewhere unintended, and this
  // line is the only place web mode reports it (mirrors the REPL banner).
  getDefaultChannel().writeLine(t("cli.web_started", { url, dir: baseDir }));
  if (!opts.noOpen) tryOpenBrowser(url);

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      web.stop();
      agent.shutdown();
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
