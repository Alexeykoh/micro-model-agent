import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { collectEnvironment, type EnvironmentReport } from "./environment";
import { sanitizeLogMessage } from "../modules/security/data-sanitizer";
import { t } from "../i18n/index";
import { errMsg } from "../utils";

export type CrashType = "uncaughtException" | "unhandledRejection";

export interface CrashEntry {
  ts: string;
  type: CrashType;
  message: string;
  stack: string;
  environment: EnvironmentReport;
}

export const CRASH_LOG_DIR = join(homedir(), ".mma", "logs");
export const CRASH_LOG_FILE = "crash.jsonl";

/** Build a sanitized crash entry. Environment is captured at crash time (no tool scan). */
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

export function writeCrashEntry(dir: string, entry: CrashEntry): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, CRASH_LOG_FILE), JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Best effort — never crash while reporting a crash
  }
}

let installed = false;

/**
 * Global crash handlers. uncaughtException is logged + re-raised (exit 1 so the
 * process never continues in a broken state); unhandledRejection is logged only
 * (the event loop keeps running). Entries land in ~/.mma/logs/crash.jsonl.
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