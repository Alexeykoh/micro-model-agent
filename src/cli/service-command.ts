/**
 * Точка входа `mma serve`: bootstrap, старт Agent Service API, жизнь процесса до
 * SIGINT/SIGTERM, затем чистое завершение.
 */
import { bootstrap } from "../core/bootstrap";
import { getDefaultChannel } from "../output";
import { t } from "../i18n/index";
import pc from "picocolors";
import { startAgentService } from "../modules/service/module";
import { publishUpdateNotice } from "../modules/service/api/host-update";
import { busLogger, createUpdater } from "../modules/updater/factory";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CONFIG_FILE, persistConfigChange } from "../config/persist";
import { readDaemonToken, rotateDaemonToken } from "../modules/daemon/protocol";

/** Опции `mma serve`: порт, хост, токен, проект. */
export interface ServeCommandOptions {
  port?: number;
  host?: string;
  token?: string;
  projectDir?: string;
  noAgentsMd?: boolean;
  /** Сгенерировать новый `~/.mma/daemon.token` и использовать его. */
  rotateToken?: boolean;
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
  const {
    agent,
    config,
    sessionManager,
    execModule,
    configDir,
    baseDir,
    spawnSessionRunner,
    memoryStore,
    skillsModule,
    indexerModule,
    lspModule,
    pluginManager,
  } = await bootstrap(...serveBootstrapArgs(opts));

  // Ротация токена — на старте: запись в `~/.mma/daemon.token`, клиенты
  // читают тот же файл. Работающий демон новый токен не подхватывает
  // (спека §12: смена токена требует рестарта).
  if (opts.rotateToken) rotateDaemonToken();
  const token = opts.token ?? readDaemonToken() ?? undefined;

  const svc = startAgentService({
    agent,
    config,
    sessionManager,
    execModule,
    memory: memoryStore,
    skills: skillsModule,
    indexer: indexerModule,
    lsp: lspModule,
    plugins: pluginManager,
    configDir,
    baseDir,
    spawnRunner: spawnSessionRunner,
    ...(configDir
      ? {
          saveConfig: (cfg, key) =>
            persistConfigChange(cfg, key, join(configDir, CONFIG_FILE), configDir),
        }
      : {}),
    reconfigure: (cfg) => agent.reconfigure(cfg),
    host: opts.host,
    port: opts.port,
    token,
  });

  const url = await svc.url;
  // Самообновление живёт в демоне: панель update в daemon-web, SSE `update`
  // в активных сессиях и общий `updateAvailable` в снапшоте состояния.
  const updater = createUpdater({
    config: config.updater,
    entryPath: fileURLToPath(import.meta.url),
    logger: busLogger(),
    onNotice: (notice) => publishUpdateNotice(svc.state, notice),
  });
  if (updater) svc.state.deps.updater = updater;
  const channel = getDefaultChannel();
  const where = { url, dir: baseDir };
  channel.writeLine(t("cli.serve_started", { ...where }));
  // Discovery сразу на старте: иначе первый вопрос «как это устроено?» уходит
  // в поиск по репозиторию вместо одного клика.
  channel.writeLine(pc.dim(t("cli.serve_docs", where)));

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      svc.stop();
      updater?.stop();
      agent.shutdown();
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
