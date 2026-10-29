// `lsp_check`: прогон проверки по списку файлов (вынесено из `module.ts`,
// правило 6 — файл на потолке `.arch-allowlist.json`).
//
// Ключевое поведение: холодный старт сервера не держит вызов весь серверный
// таймаут (30 с в живой сессии `ses_mvoac9q9`). Ждём тёплое соединение не дольше
// бюджета, прогреваем в фоне, непроверенные файлы честно называем в отчёте.
import type { CheckResult, LspClient, LspClientLogger } from "./client";
import type { LspConfig, LspDiagnostic, LspServerConfig } from "./types";
import { isErrorDiagnostic, isWarningDiagnostic } from "./types";
import { getServerForFile } from "./config";
import { findProjectRoot } from "./project-root";
import { serverKeyFor } from "./client";
import { toForwardSlash } from "../../tools/path-utils";
import { relative, join } from "path";
import { existsSync } from "fs";
import { errMsg } from "../../utils";
import type { LspHealth } from "./health";
import type { CheckAccumulator } from "./check-report";

/** Сколько ждём холодный старт сервера внутри `lsp_check`. */
export const CHECK_WARMUP_MS = 4000;
/** Бюджет проверки одного файла в `lsp_check` (сервер уже тёплый). */
export const CHECK_FILE_TIMEOUT_MS = 8000;

/** Диагностики разреза модулей без tsconfig/node_modules — шум, не ошибки кода. */
const TYPE_ENV_DIAG_PATTERN =
  /Cannot find module ['"][^'"]+['"] or its corresponding type declarations|Cannot find name '(__dirname|__filename|require|process|Buffer|console)'|Do you need to install type definitions/;

/** Есть ли рядом с корнем проекта окружение типов (tsconfig/jsconfig/node_modules). */
function hasTypeEnvironment(projectRoot: string): boolean {
  return (
    existsSync(join(projectRoot, "tsconfig.json")) ||
    existsSync(join(projectRoot, "jsconfig.json")) ||
    existsSync(join(projectRoot, "node_modules"))
  );
}

/** Всё, что нужно прогону проверки (модуль отдаёт свои швы). */
export interface CheckRunDeps {
  baseDir: string;
  config: LspConfig;
  client: Pick<LspClient, "isWarm" | "warmup" | "checkFile">;
  health: LspHealth;
  logger: LspClientLogger | null;
  /** Бюджет проверки одного файла; по умолчанию `CHECK_FILE_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Заметка о сбое сервера (модуль форматирует её по своей политике). */
  failureNote(key: string, serverConfig: LspServerConfig, message: string, file: string): string;
}

/** Проверить набор файлов, накопив диагностики и заметки о сбоях. */
export async function runCheckFiles(
  files: string[],
  deps: CheckRunDeps,
): Promise<CheckAccumulator> {
  const acc: CheckAccumulator = {
    baseDir: deps.baseDir,
    errors: [],
    warnings: [],
    notes: [],
    checkedFiles: [],
    checked: 0,
    inconclusive: 0,
    suppressed: 0,
    cold: 0,
  };
  for (const file of files) {
    const serverConfig = getServerForFile(file, deps.config);
    if (!serverConfig) continue;
    const key = serverKeyFor(serverConfig);
    if (deps.health.isDisabled(key)) continue;
    const projectRoot = findProjectRoot(
      file,
      deps.baseDir,
      serverConfig.workspaceMarkers ?? [],
    );
    if (!(await warmWithin(deps, serverConfig, projectRoot))) {
      acc.cold++;
      continue;
    }
    try {
      const budget = deps.timeoutMs ?? CHECK_FILE_TIMEOUT_MS;
      const result = await deps.client.checkFile(
        file,
        deps.baseDir,
        serverConfig,
        projectRoot,
        Math.min(serverConfig.timeout ?? budget, budget),
      );
      deps.health.reset(key);
      collectDiagnostics(acc, file, deps.baseDir, result, projectRoot);
    } catch (e) {
      deps.health.warn(deps.logger, file, errMsg(e));
      acc.notes.push(deps.failureNote(key, serverConfig, errMsg(e), file));
    }
  }
  return acc;
}

/**
 * Ждёт тёплое соединение не дольше `CHECK_WARMUP_MS` (и серверного таймаута, если
 * он меньше). Прогрев не отменяется по таймауту: соединение доедет в пул в фоне,
 * поэтому повторный `lsp_check` увидит сервер тёплым.
 */
async function warmWithin(
  deps: CheckRunDeps,
  serverConfig: LspServerConfig,
  projectRoot: string,
): Promise<boolean> {
  if (deps.client.isWarm(serverConfig, projectRoot)) return true;
  const budget = Math.min(serverConfig.timeout ?? CHECK_WARMUP_MS, CHECK_WARMUP_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budget);
  });
  try {
    await Promise.race([deps.client.warmup(serverConfig, projectRoot).catch(() => {}), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return deps.client.isWarm(serverConfig, projectRoot);
}

/** Сложить диагностики одного файла в аккумулятор (с type-env фильтром). */
function collectDiagnostics(
  acc: CheckAccumulator,
  file: string,
  baseDir: string,
  result: CheckResult,
  projectRoot: string,
): void {
  acc.checked++;
  acc.checkedFiles.push(toForwardSlash(relative(baseDir, file)));
  let diags = result.diagnostics;
  if (!hasTypeEnvironment(projectRoot)) {
    diags = diags.filter((d: LspDiagnostic) => {
      if (TYPE_ENV_DIAG_PATTERN.test(d.message)) {
        acc.suppressed++;
        return false;
      }
      return true;
    });
  }
  if (result.inconclusive) acc.inconclusive++;
  for (const d of diags) {
    if (isErrorDiagnostic(d)) acc.errors.push({ file, diag: d });
    else if (isWarningDiagnostic(d)) acc.warnings.push({ file, diag: d });
  }
}
