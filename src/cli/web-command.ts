/**
 * Точка входа `mma web`: bootstrap, старт браузерного UI, жизнь процесса до
 * SIGINT/SIGTERM, затем чистое завершение.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap } from "../core/bootstrap";
import { agentsMdPaths } from "../core/bootstrap";
import { getDefaultChannel } from "../output";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { startWebUi } from "../modules/webui/module";
import { broadcast, type WebUiState } from "../modules/webui/state";
import { pushState } from "../modules/webui/session/session-status";
import { tryOpenBrowser } from "../modules/webui/server";
import { globalMmaDir } from "../config/paths";
import { MMA_ENV } from "../config/env";
import { createUpdater, busLogger, type UpdaterModule } from "../modules/updater/index";
import type { AppConfig } from "../config/types";

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
    throw new Error(t("cli.web_invalid_port", { port: raw }));
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

/**
 * Стартует апдейтер для веб-режима.
 *
 * Раньше веб его не запускал вовсе: `exitOnComplete=true` выключал апдейтер
 * целиком, и переключатели `updater.*` в панели настроек были мёртвыми. Флаг
 * существует ради владения stdin, а апдейтер в stdin не лезет (fetch + execFile),
 * поэтому связь была ложной. Теперь апдейтер работает в обоих режимах, а веб
 * получает факт апдейта через SSE-событие `update`.
 *
 * Проверка fire-and-forget: `createUpdater` возвращается сразу, бинд сервера
 * не ждёт npm-реестр. `latest` кладём ещё и в снапшот — по правилу
 * event-sourced state постоянный факт едет в `state`, а не отдельным типом;
 * событие `update` нужно маскоту для реакции в момент обнаружения.
 */
function startWebUpdater(config: AppConfig, state: WebUiState): UpdaterModule | undefined {
  const note = (current: string, latest?: string): void => {
    state.updateAvailable = latest ? { current, latest } : undefined;
    pushState(state);
  };
  return createUpdater({
    config: config.updater,
    entryPath: fileURLToPath(import.meta.url),
    // Печатаем уведомления и в терминал (а не только в SSE-чип): `mma web`
    // раньше молчал об апдейте в консоли, где его и ждут.
    logger: busLogger(),
    onNotice: (notice) => {
      broadcast({ type: "update", ts: Date.now(), ...notice }, state);
      if (notice.phase === "available" && notice.latest) {
        note(notice.current, notice.latest);
      } else if (notice.phase !== "available") {
        // Установлено (или провалилось) — чип «доступно обновление» больше
        // не про то; версия сменится только на следующем старте процесса.
        note(notice.current);
      }
    },
  });
}

/** Запуск веб-режима: bootstrap → старт UI → ожидание SIGINT/SIGTERM. */
export async function runWeb(opts: WebCommandOptions): Promise<void> {
  // Транспорт читает их на старте (server/state): у порта нет поля конфига,
  // так что CLI-флаг маппится на env, которую сервер уже уважает.
  if (opts.port !== undefined) process.env[MMA_ENV.WEBUI_PORT] = String(opts.port);
  if (opts.host) process.env[MMA_ENV.WEBUI_HOST] = opts.host;
  if (opts.token) process.env[MMA_ENV.WEBUI_TOKEN] = opts.token;
  if (opts.noOpen) process.env[MMA_ENV.WEBUI_OPEN] = "0";

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
    lspModule,
    memoryStore,
    skillsModule,
    pluginManager,
    toolRegistry,
    toolCtx,
    contextProbe,
    spawnSessionRunner,
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
    lsp: lspModule,
    contextProbe,
    host: opts.host,
    token: opts.token,
    setupRequired: virgin,
    spawnRunner: spawnSessionRunner,
  });

  // Апдейтер стартует после UI: уведомления идут через `state`, который
  // `startWebUi` уже создал. Ни одного клиента в момент старта может не быть —
  // тогда апдейт уедет в снапшот и чип появится у следующего подключения.
  const updater = startWebUpdater(config, web.state);
  // Кнопка «Update» в web: серверная установка (в dev `install` — no-op из-за
  // `setInstallEnabled(false)`, поэтому кнопка честно вернёт ошибку).
  if (updater) web.state.updaterInstall = () => updater.getUpdater().install();

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
      updater?.stop();
      web.stop();
      agent.shutdown();
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
