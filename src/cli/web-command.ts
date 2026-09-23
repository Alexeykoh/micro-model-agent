/**
 * `mma web` entry point: bootstrap, start the browser UI, keep the process alive
 * until SIGINT/SIGTERM, then shut down cleanly.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { bootstrap } from "../core/bootstrap";
import { getDefaultChannel } from "../output";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { startWebUi } from "../modules/webui/module";
import { tryOpenBrowser } from "../modules/webui/server";

export interface WebCommandOptions {
  port?: number;
  host?: string;
  token?: string;
  noOpen?: boolean;
  projectDir?: string;
}

export async function runWeb(opts: WebCommandOptions): Promise<void> {
  // The transport reads these at startup (server/state): port has no config
  // field, so the CLI flag maps onto the env var the server already honours.
  if (opts.port !== undefined) process.env.MMA_WEBUI_PORT = String(opts.port);
  if (opts.host) process.env.MMA_WEBUI_HOST = opts.host;
  if (opts.token) process.env.MMA_WEBUI_TOKEN = opts.token;
  if (opts.noOpen) process.env.MMA_WEBUI_OPEN = "0";

  const mmaDir = process.env.MMA_CONFIG_DIR || join(homedir(), ".mma");
  const { hasDomainFiles } = await import("../config/domains");
  const virgin = !existsSync(join(mmaDir, "config.json")) && !hasDomainFiles(mmaDir);

  // exitOnComplete=true: no interactive prompt owns stdin in web mode.
  const { agent, config, sessionManager, execModule } = await bootstrap(
    undefined,
    opts.projectDir,
    undefined,
    true,
  );

  if (virgin) {
    getDefaultChannel().writeLine(pc.yellow(`  ${t("cli.first_run_oneshot")}`), "stderr");
  }

  const web = await startWebUi({
    agent,
    config,
    sessionManager,
    execModule,
    host: opts.host,
    token: opts.token,
  });

  const url = await web.url;
  getDefaultChannel().writeLine(t("cli.web_started", { url }));
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
