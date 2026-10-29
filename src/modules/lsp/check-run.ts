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
import type { LspProbeError } from "./connection-types";
import { stderrTailLines } from "./stderr-lines";
import { LSP_CHECK_FILE_MS, LSP_CHECK_WARMUP_MS } from "../../config/timeouts";
import { t } from "../../i18n/index";

/**
 * Сколько ждём холодный старт сервера внутри явной проверки. Единственный
 * источник — `config/timeouts.ts` (`LSP_CHECK_WARMUP_MS`), чтобы число не
 * расползалось по модулю и было объяснено там же.
 */
export const CHECK_WARMUP_MS = LSP_CHECK_WARMUP_MS;
/** Бюджет проверки одного файла в `lsp_check` (сервер уже тёплый). */
export const CHECK_FILE_TIMEOUT_MS = LSP_CHECK_FILE_MS;

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
  /** Бюджет ожидания холодного старта (тесты); `CHECK_WARMUP_MS`. */
  warmupMs?: number;
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
    unsupported: [],
  };
  for (const file of files) {
    const serverConfig = getServerForFile(file, deps.config);
    if (!serverConfig) {
      acc.unsupported.push(file);
      continue;
    }
    const key = serverKeyFor(serverConfig);
    if (deps.health.isDisabled(key)) {
      // Пауза восстановления: не пробуем и честно говорим, сколько ждать.
      acc.notes.push(
        t("lsp.check_paused", {
          sec: String(Math.ceil(deps.health.retryInMs(key) / 1000)),
        }),
      );
      continue;
    }
    const projectRoot = findProjectRoot(
      file,
      deps.baseDir,
      serverConfig.workspaceMarkers ?? [],
    );
    const warmed = await warmWithin(deps, serverConfig, projectRoot);
    if (!warmed.ok) {
      if (!warmed.error) {
        acc.cold++;
        // Бюджет ожидания истёк, а сервер ещё стартует: это видно в логе,
        // иначе «lsp_check неокончателен» не отличить от упавшего сервера.
        deps.logger?.info(
          `LSP check skipped: ${file} — server still starting after ${CHECK_WARMUP_MS}ms`,
          { op: "check_cold", server: key, file, root: projectRoot, budgetMs: CHECK_WARMUP_MS },
        );
        continue;
      }
      // Прогрев отвергся (spawn/initialize): это не «ещё запускается», а
      // падение. Ошибка уходит в health и в отчёт — иначе сервер, который
      // никогда не стартует (несовместимый Node), выглядит вечным холодным
      // стартом, а `/lsp status` пишет «все серверы работают». Хвост stderr
      // прикладывает пул: упавший сервер отвечает «connection closed», а
      // настоящая причина остаётся только в его выводе.
      const failure = warmFailureText(warmed.error, warmed.stderrTail);
      deps.health.warn(deps.logger, file, failure);
      deps.logger?.info(`LSP check failed: ${file} — ${failure.split("\n")[0]}`, {
        op: "check_failed",
        server: key,
        file,
        root: projectRoot,
        error: failure,
      });
      acc.notes.push(deps.failureNote(key, serverConfig, failure, file));
      continue;
    }
    try {
      const budget = deps.timeoutMs ?? CHECK_FILE_TIMEOUT_MS;
      const started = Date.now();
      const result = await deps.client.checkFile(
        file,
        deps.baseDir,
        serverConfig,
        projectRoot,
        Math.min(serverConfig.timeout ?? budget, budget),
      );
      deps.health.reset(key);
      collectDiagnostics(acc, file, deps.baseDir, result, projectRoot);
      // След в app.jsonl: что проверяли, сколько заняло, что нашли. Без этого
      // «lsp_check прошёл» неотличим от «сервер молчал».
      deps.logger?.info(
        `LSP check ${file} in ${Date.now() - started}ms ` +
          `(${result.diagnostics.length} diagnostic(s)${result.inconclusive ? ", inconclusive" : ""})`,
        {
          op: "check",
          server: key,
          file,
          root: projectRoot,
          durMs: Date.now() - started,
          diagnostics: result.diagnostics.length,
          inconclusive: result.inconclusive,
        },
      );
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
 *
 * Три исхода различимы: тёплый (`ok`), упавший прогрев (`ok: false` + `error`) и
 * всё ещё идущий (`ok: false` без `error`). Раньше первые два были одним
 * `false`, и крах сервера печатался как «ещё запускается».
 *
 * Бюджет ожидания: `CHECK_WARMUP_MS`, но не больше бюджета самого вызова
 * (`timeoutMs`) и серверного таймаута. Явная проверка (REPL/веб-панель) может
 * ждать холодный старт до 15 с — `initialize` Next.js-подпроекта в монолите в
 * прежние 4 с не укладывался, и «сервер ещё запускается» печаталось на каждой
 * попытке. Пакетная проверка изменённых файлов передаёт свой короткий бюджет
 * (6 с), поэтому там ожидание остаётся коротким.
 */
async function warmWithin(
  deps: CheckRunDeps,
  serverConfig: LspServerConfig,
  projectRoot: string,
): Promise<{ ok: boolean; error?: string; stderrTail?: string }> {
  if (deps.client.isWarm(serverConfig, projectRoot)) return { ok: true };
  const cap = deps.warmupMs ?? CHECK_WARMUP_MS;
  const callerCap = deps.timeoutMs ?? cap;
  const budget = Math.min(serverConfig.timeout ?? cap, cap, callerCap);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budget);
  });
  const state: { failure?: { message: string; stderrTail?: string } } = {};
  // Отказ прогрева запоминаем, а не бросаем: поздний отказ (после бюджета) не
  // должен стать unhandled rejection.
  const warm = deps.client.warmup(serverConfig, projectRoot).then(
    () => {},
    (e: unknown) => {
      state.failure = { message: errMsg(e), stderrTail: (e as LspProbeError).stderrTail };
    },
  );
  try {
    await Promise.race([warm, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (deps.client.isWarm(serverConfig, projectRoot)) return { ok: true };
  const failure = state.failure;
  return failure ? { ok: false, error: failure.message, stderrTail: failure.stderrTail } : { ok: false };
}

/**
 * Текст падения прогрева для отчёта: сообщение клиента + до 3 строк stderr.
 * Упавший сервер сообщает только «connection closed», поэтому без stderr строка
 * `[LSP check failed]` бесполезна и модели, и человеку.
 */
function warmFailureText(error: string, stderrTail: string | undefined): string {
  const lines = stderrTailLines(stderrTail);
  return lines.length > 0 ? `${error}\n${lines.join("\n")}` : error;
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
