/** Глобальные обработчики падений: запись краша в ~/.mma/logs/crash.jsonl. */
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { collectEnvironment, type EnvironmentReport } from "./environment";
import { sanitizeLogMessage } from "../modules/security/data-sanitizer";
import { t } from "../i18n/index";
import { errMsg } from "../utils";
import { globalLogsDir } from "../config/paths";

/** Тип падения: непойманное исключение или необработанный reject. */
export type CrashType = "uncaughtException" | "unhandledRejection";

/** Запись о падении: время, тип, сообщение, стек, окружение. */
export interface CrashEntry {
  ts: string;
  type: CrashType;
  message: string;
  stack: string;
  environment: EnvironmentReport;
}

/** Каталог краш-логов. */
export const CRASH_LOG_DIR = globalLogsDir();
/** Имя файла краш-лога. */
export const CRASH_LOG_FILE = "crash.jsonl";

/**
 * Строит санитизированную запись о падении. Окружение снимается в момент
 * краша (без сканирования тулов).
 */
export function formatCrashEntry(type: CrashType, err: unknown): CrashEntry {
  const message = errMsg(err);
  const stack = err instanceof Error && err.stack ? err.stack : message;
  return {
    ts: new Date().toISOString(),
    type,
    message: sanitizeLogMessage(message),
    stack: sanitizeLogMessage(stack),
    environment: collectEnvironment({ configDir: homedir(), scanTools: false }),
  };
}

/**
 * Дописывает запись в краш-лог. Best-effort: отчёт о краше никогда не роняет процесс.
 */
export function writeCrashEntry(dir: string, entry: CrashEntry): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, CRASH_LOG_FILE), `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // Best-effort — отчёт о краше не должен ронять процесс
  }
}

let installed = false;

/**
 * Ставит глобальные обработчики. uncaughtException логируется и завершает
 * процесс (exit 1 — продолжение в битом состоянии недопустимо);
 * unhandledRejection только логируется (цикл продолжает работу).
 */
export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;

  process.on("uncaughtException", (err) => {
    const entry = formatCrashEntry("uncaughtException", err);
    writeCrashEntry(CRASH_LOG_DIR, entry);
    process.stderr.write(
      `${t("env.crash_stderr", { type: entry.type, message: entry.message })}\n`,
    );
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const entry = formatCrashEntry("unhandledRejection", reason);
    writeCrashEntry(CRASH_LOG_DIR, entry);
    process.stderr.write(
      `${t("env.crash_stderr", { type: entry.type, message: entry.message })}\n`,
    );
  });
}