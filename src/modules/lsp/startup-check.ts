// Стартовый health-check проекта: предсуществующие ошибки в промпт до начала работы.
import { existsSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { t } from "../../i18n/index";
import type { PromptBlock } from "../../core/types";
import type { LspConfig, LspDiagnostic } from "./types";
import { LspClient } from "./client";
import { collectCheckFiles } from "./check-tool";
import { getServerForFile } from "./config";
import { findProjectRoot, resolveTscCommand } from "./project-root";
import { estimateTokens } from "../../llm/token-counter";
import { errMsg } from "../../utils";
import { LSP_STARTUP_CHECK_TIMEOUT_MS as STARTUP_CHECK_TIMEOUT_MS } from "../../config/timeouts";

/** Стартовый чек смотрит не больше этого числа файлов через LSP. */
const STARTUP_CHECK_FILE_CAP = 5;
/** Кап строк ошибок tsc в промпт-блоке. */
const STARTUP_CHECK_ERROR_CAP = 20;

/** Зависимости стартового чека (инжекции для тестов). */
export interface StartupHealthDeps {
  client?: LspClient;
  /** Инжектируемый запуск tsc (тесты). Возвращает распарсенные "error TS" строки. */
  runTsc?: (projectRoot: string, timeoutMs: number) => Promise<string[]>;
  /** Логгер для отчётов об ошибках. */
  logger?: { debug(msg: string, meta?: Record<string, unknown>): void; info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void; error(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * Сканирует проект на старте сессии на уже существующие ошибки, чтобы модель
 * знала baseline ДО начала работы. Закрывает прерванные сессии: недоломанный
 * прошлым запуском код всплывает сразу, а не находится (или пропускается)
 * реактивно.
 *
 * Стратегия:
 * - есть tsconfig.json → один `tsc --noEmit --skipLibCheck` (один процесс на
 *   весь проект);
 * - иначе → ограниченные LSP-диагностики до STARTUP_CHECK_FILE_CAP файлов
 *   (CSS/JSON/чистый-JS проекты без TS).
 *
 * Всегда fail-open: любая ошибка/таймаут/чистый результат → null, чек не
 * может замедлить или сломать старт сессии.
 */
/** Запустить стартовый health-check; нечего показать — null. */
export async function runStartupHealthCheck(
  config: LspConfig,
  baseDir: string,
  deps: StartupHealthDeps = {},
): Promise<PromptBlock | null> {
  if (!config.enabled) return null;

  try {
    const result = await Promise.race([
      runCheck(config, baseDir, deps),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), STARTUP_CHECK_TIMEOUT_MS)),
    ]);
    if (!result || result.lines.length === 0) return null;

    const content = `${t("lsp.startup_header")}\n${result.lines.join("\n")}`;
    return {
      content,
      priority: "high" as const,
      essential: false,
      estimatedTokens: estimateTokens(content),
    };
  } catch {
    return null;
  }
}

async function runCheck(
  config: LspConfig,
  baseDir: string,
  deps: StartupHealthDeps,
): Promise<{ lines: string[] } | null> {
  const projectRoot = findProjectRoot(baseDir, baseDir, ["tsconfig.json", "package.json"]);

  if (existsSync(join(projectRoot, "tsconfig.json"))) {
    const runTsc = deps.runTsc ?? runTscDefault;
    const errors = await runTsc(projectRoot, STARTUP_CHECK_TIMEOUT_MS);
    if (errors.length === 0) return null;
    return { lines: errors.slice(0, STARTUP_CHECK_ERROR_CAP) };
  }

  const client = deps.client ?? new LspClient();
  if (!deps.client) client.setLogger(deps.logger ?? null);
  const files = await collectCheckFiles(baseDir, config);
  const lines: string[] = [];
  let checked = 0;
  for (const file of files.slice(0, STARTUP_CHECK_FILE_CAP)) {
    const serverConfig = getServerForFile(file, config);
    if (!serverConfig) continue;
    const fileRoot = findProjectRoot(file, baseDir, serverConfig.workspaceMarkers ?? []);
    try {
      const diags = await client.checkFile(file, baseDir, serverConfig, fileRoot);
      checked++;
      for (const d of diags) {
        if (d.severity === 1) {
          lines.push(formatStartupError(file, baseDir, d));
        }
      }
    } catch (e) {
      // Упавший LSP на файле → лог и пропуск (fail-open).
      deps.logger?.debug(`Startup LSP check failed for ${file}: ${errMsg(e)}`);
    }
  }
  if (checked === 0 || lines.length === 0) return null;
  return { lines: lines.slice(0, STARTUP_CHECK_ERROR_CAP) };
}

async function runTscDefault(projectRoot: string, timeoutMs: number): Promise<string[]> {
  // Локальный tsc, а не `npx`: npx-обёртка (cmd → node npm-prefix) медленная и
  // на Windows переживает выход процесса, оставляя открытым stdout-пайп —
  // команда «виснет». Нет локального tsc — молча пропускаем проверку.
  const tsc = resolveTscCommand(projectRoot);
  if (!tsc) return [];
  return new Promise((resolve) => {
    const child = spawn(`${tsc} --noEmit --skipLibCheck`, {
      cwd: projectRoot,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve([]);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseTscErrors(out));
    });
  });
}

/** Распарсить "error TS" строки из вывода tsc (дедуп). */
export function parseTscErrors(output: string): string[] {
  const lines: string[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/^[a-zA-Z]:/, "").trim();
    if (line.includes("error TS")) lines.push(line);
  }
  return dedupe(lines);
}

function formatStartupError(file: string, baseDir: string, d: LspDiagnostic): string {
  const rel = file.replace(baseDir.replace(/[\\/]$/, ""), "").replace(/^[\\/]/, "");
  const line = d.range.start.line + 1;
  const col = d.range.start.character + 1;
  return `  ${rel || file}(${line},${col}): error: ${d.message}`;
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}
