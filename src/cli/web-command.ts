/**
 * Точка входа `mma web`: bootstrap, старт браузерного UI, жизнь процесса до
 * SIGINT/SIGTERM, затем чистое завершение.
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

/** Опции `mma web`: порт, хост, токен, suppress автооткрытия, проект. */
export interface WebCommandOptions {
  port?: number;
  host?: string;
  token?: string;
  noOpen?: boolean;
  projectDir?: string;
  noAgentsMd?: boolean;
}

/**
 * Парсит и валидирует флаг `--port`. `undefined`/пусто → `undefined` (рандомный
 * порт). Нечисловые и вне диапазона бросают throw, а не молча откатываются на
 * рандом: `--port abc` не должен маскироваться под рабочий bind.
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
 * Аргументы bootstrap для `runWeb`. Вынесены, чтобы форвардинг CLI-флагов
 * (особенно `--no-agents-md`) был юнит-тестируем без подъёма настоящего агента:
 * Bun-моки модулей процесс-глобальны, спай на `bootstrap` потёк бы.
 */
export function webBootstrapArgs(
  opts: WebCommandOptions,
): [undefined, string | undefined, boolean | undefined, true] {
  return [undefined, opts.projectDir, opts.noAgentsMd, true];
}

/** Запуск веб-режима: bootstrap → старт UI → ожидание SIGINT/SIGTERM. */
export async function runWeb(opts: WebCommandOptions): Promise<void> {
  // Транспорт читает их на старте (server/state): у порта нет поля конфига,
  // так что CLI-флаг маппится на env, которую сервер уже уважает.
  if (opts.port !== undefined) process.env.MMA_WEBUI_PORT = String(opts.port);
  if (opts.host) process.env.MMA_WEBUI_HOST = opts.host;
  if (opts.token) process.env.MMA_WEBUI_TOKEN = opts.token;
  if (opts.noOpen) process.env.MMA_WEBUI_OPEN = "0";

  const mmaDir = globalMmaDir();
  const { hasDomainFiles } = await import("../config/domains");
  const virgin = !existsSync(join(mmaDir, "config.json")) && !hasDomainFiles(mmaDir);

  // exitOnComplete=true: в веб-режиме интерактивный промпт stdin не владеет.
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
  // Всегда показываем резолвленный workspace: shell-нарезка `-d` пути (пробелы,
  // хвостовой бэкслэш) может молча указать не туда, и эта строка — единственное
  // место, где веб-режим его репортит (зеркало баннера REPL).
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
