// Структурная диагностика одного файла для веб-панели LSP (`POST /api/lsp/check`).
//
// Отличие от `lsp_check`: панели нужны данные (строка/колонка/уровень/текст), а
// не текстовый отчёт модели, и путь приходит из браузера, поэтому jail здесь
// обязателен. Кап — 200 диагностик по 300 символов: панель не должна умирать на
// сгенерированном файле.
import { existsSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import type { LspClient, LspClientLogger } from "./client";
import type { LspConfig, LspDiagnostic, LspServerConfig } from "./types";
import type { LspHealth } from "./health";
import { runCheckFiles } from "./check-run";

/** Максимум диагностик в ответе панели. */
export const WEB_CHECK_LIMIT = 200;
/**
 * Бюджет проверки файла из панели. Дольше, чем `lsp_check` агента (8 с):
 * пользователь ждёт интерактивно и видит счётчик секунд, а холодная загрузка
 * TS-проекта на этой машине занимает ~9.6 с — короткий бюджет отдавал
 * `lsp-timeout` при живом сервере.
 */
export const WEB_CHECK_TIMEOUT_MS = 15_000;
const MESSAGE_MAX = 300;

export interface WebCheckDeps {
  baseDir: string;
  config: LspConfig;
  client: Pick<LspClient, "isWarm" | "warmup" | "checkFile">;
  health: LspHealth;
  logger: LspClientLogger | null;
  failureNote(key: string, serverConfig: LspServerConfig, message: string, file: string): string;
}

export interface WebDiagnostic {
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface WebCheckResult {
  ok: boolean;
  path: string;
  diagnostics: WebDiagnostic[];
  truncated?: boolean;
  ms?: number;
  /** `outside-workspace` | `not-found` | `disabled` | `lsp-failed`. */
  error?: string;
}

/** Путь внутри workspace? Тот же jail, что у `/api/file`. */
export function isInsideWorkspace(baseDir: string, absPath: string): boolean {
  const rel = relative(resolve(baseDir), resolve(absPath));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function levelOf(diag: LspDiagnostic): WebDiagnostic["severity"] {
  const sev = diag.severity ?? 1;
  if (sev === 1) return "error";
  if (sev === 2) return "warning";
  return "info";
}

function toWebDiagnostic(diag: LspDiagnostic): WebDiagnostic {
  return {
    line: diag.range.start.line + 1,
    column: diag.range.start.character + 1,
    severity: levelOf(diag),
    message: String(diag.message || "").slice(0, MESSAGE_MAX),
  };
}

/** Проверить один файл; ошибки — данными, не исключениями. */
export async function runWebCheck(
  relPath: string,
  deps: WebCheckDeps,
  timeoutMs = WEB_CHECK_TIMEOUT_MS,
): Promise<WebCheckResult> {
  const started = Date.now();
  const raw = String(relPath || "").trim();
  const path = raw.replace(/\\/g, "/");
  if (!path) return { ok: false, path, diagnostics: [], error: "not-found" };
  const abs = resolve(deps.baseDir, path);
  if (!isInsideWorkspace(deps.baseDir, abs)) {
    return { ok: false, path, diagnostics: [], error: "outside-workspace" };
  }
  if (!existsSync(abs)) return { ok: false, path, diagnostics: [], error: "not-found" };
  if (!deps.config.enabled) {
    return { ok: false, path, diagnostics: [], error: "disabled" };
  }

  const acc = await runCheckFiles([abs], {
    baseDir: deps.baseDir,
    config: deps.config,
    client: deps.client,
    health: deps.health,
    logger: deps.logger,
    failureNote: deps.failureNote,
    timeoutMs,
  });

  const all = [...acc.errors, ...acc.warnings].map((e) => toWebDiagnostic(e.diag));
  // Ошибки первыми: панель показывает их сверху.
  all.sort((a, b) => (a.severity === b.severity ? a.line - b.line : a.severity === "error" ? -1 : 1));
  const diagnostics = all.slice(0, WEB_CHECK_LIMIT);
  // `inconclusive` тоже инкрементит `checked`: сервер не ответил, и это НЕ
  // «ошибок нет» — панель обязана сказать про таймаут, а не про чистый файл.
  if (acc.checked === 0 || acc.inconclusive > 0) {
    return {
      ok: false,
      path,
      diagnostics,
      truncated: all.length > diagnostics.length,
      ms: Date.now() - started,
      error: acc.inconclusive > 0 ? "lsp-timeout" : "lsp-failed",
    };
  }
  return {
    ok: true,
    path,
    diagnostics,
    truncated: all.length > diagnostics.length,
    ms: Date.now() - started,
  };
}
