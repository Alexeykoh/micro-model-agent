/**
 * Точка входа `mma serve`: bootstrap, старт Agent Service API, жизнь процесса до
 * SIGINT/SIGTERM, затем чистое завершение.
 */
import { bootstrap } from "../core/bootstrap";
import { getDefaultChannel } from "../output";
import { t } from "../i18n/index";
import pc from "picocolors";
import { startAgentService } from "../modules/service/module";

/** Опции `mma serve`: порт, хост, токен, проект. */
export interface ServeCommandOptions {
  port?: number;
  host?: string;
  token?: string;
  projectDir?: string;
  noAgentsMd?: boolean;
}

/**
 * Парсит и валидирует `--port`. `undefined`/пусто → `undefined` (порт из
 * `service.port`). Нечисловое/вне диапазона бросает: `--port abc` не маскируется
 * под рабочий bind.
 */
export function parseServePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(t("cli.serve_invalid_port", { port: raw }));
  }
  return n;
}

/**
 * Аргументы bootstrap для `runServe` (вынесены для юнит-теста форвардинга
 * `--no-agents-md` без подъёма агента).
 */
export function serveBootstrapArgs(
  opts: ServeCommandOptions,
): [undefined, string | undefined, boolean | undefined, true] {
  return [undefined, opts.projectDir, opts.noAgentsMd, true];
}

/** Запуск сервиса: bootstrap → старт API → ожидание SIGINT/SIGTERM. */
export async function runServe(opts: ServeCommandOptions): Promise<void> {
  // exitOnComplete=true: интерактивный промпт stdin в сервисе не владеет.
  const { agent, config, sessionManager, execModule, configDir, baseDir, spawnSessionRunner } =
    await bootstrap(...serveBootstrapArgs(opts));

  const svc = startAgentService({
    agent,
    config,
    sessionManager,
    execModule,
    configDir,
    baseDir,
    spawnRunner: spawnSessionRunner,
    host: opts.host,
    port: opts.port,
    token: opts.token,
  });

  await svc.url;
  const channel = getDefaultChannel();
  const where = { host: svc.state.host, port: String(svc.state.port) };
  channel.writeLine(t("cli.serve_started", { ...where, dir: baseDir }));
  // Discovery сразу на старте: иначе первый вопрос «как это устроено?» уходит
  // в поиск по репозиторию вместо одного клика.
  channel.writeLine(pc.dim(t("cli.serve_docs", where)));

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      svc.stop();
      agent.shutdown();
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
