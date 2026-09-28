/** Отчёт об окружении: рантайм, ОС, тулы, провайдер, Playwright. */
import { existsSync, readFileSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { arch, homedir, hostname, platform, release } from "os";
import { env } from "process";
import { readMmaVersion } from "./version";
import { sanitizeUrl } from "../modules/security/network-validator";
import { t } from "../i18n/index";
import type { Logger } from "../logger/app-logger";
import type { AppConfig } from "../config/types";

/** Имя рантайма JS. */
export type RuntimeName = "bun" | "node" | "unknown";

/** Информация о рантайме: движок, версии, соответствие engines. */
export interface RuntimeInfo {
  runtime: RuntimeName;
  runtimeVersion: string;
  nodeVersion: string;
  engine: string;
  engineOk: boolean;
}

/** Структурный отчёт об окружении для лога и диагностики. */
export interface EnvironmentReport {
  ts: string;
  mmaVersion: string;
  runtime: RuntimeInfo;
  os: {
    platform: string;
    arch: string;
    release: string;
    hostname: string;
    shell: string;
    home: string;
    cwd: string;
  };
  paths: { configDir: string; baseDir: string };
  tools: Record<string, string>;
  provider: {
    model: string;
    baseUrl: string;
    contextWindow: number;
    retry: Record<string, number>;
  } | null;
  features: { browser: boolean };
  playwright: {
    installed: boolean;
    version: string;
    browsersDir: string;
    browsersInstalled: boolean;
  } | null;
  warnings: string[];
}

/** Тулы, проверяемые в PATH (только реальные бинари, без .cmd-шимов). */
const TOOL_CHECKS = ["bun", "node", "git", "python"];

function readEngineRequirement(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "..", "package.json"), join(here, "..", "package.json")];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      if (raw.engines?.node) return String(raw.engines.node);
    } catch {
      // Битый package.json — пропускаем
    }
  }
  return ">=20";
}

/**
 * Проверяет версию against минимума из requirement (напр. `>=20`).
 * @param version проверяемая версия; @param requirement требование engines.
 * @returns true, если версия не ниже минимальной.
 */
export function satisfiesMinimum(version: string, requirement: string): boolean {
  const minMatch = requirement.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!minMatch) return true;
  const min = [
    parseInt(minMatch[1], 10),
    minMatch[2] ? parseInt(minMatch[2], 10) : 0,
    minMatch[3] ? parseInt(minMatch[3], 10) : 0,
  ];
  const parts = version.replace(/^v/i, "").split(".");
  const got = [
    parts[0] ? parseInt(parts[0], 10) : 0,
    parts[1] ? parseInt(parts[1], 10) : 0,
    parts[2] ? parseInt(parts[2], 10) : 0,
  ];
  for (let i = 0; i < 3; i++) {
    if (got[i] > min[i]) return true;
    if (got[i] < min[i]) return false;
  }
  return true;
}

/**
 * Детектит рантайм (Bun vs Node) и сверяет Node с engines из package.json.
 * @returns информация о рантайме.
 */
export function detectRuntime(): RuntimeInfo {
  const bun = (globalThis as { Bun?: { version?: string } }).Bun;
  const isBun = typeof bun !== "undefined" && typeof bun?.version !== "undefined";
  const engine = readEngineRequirement();
  const runtime: RuntimeName = isBun ? "bun" : "node";
  const runtimeVersion = isBun ? String(bun.version) : process.version;
  return {
    runtime,
    runtimeVersion,
    nodeVersion: process.version,
    engine,
    // engines.node — про Node-рантайм. Bun проходит через встроенный Node
    // (process.version); версию самого Bun с требованием не сравниваем
    // (Bun 1.x всегда выглядел бы «слишком старым»).
    engineOk: satisfiesMinimum(process.version, engine),
  };
}

function toolVersion(cmd: string): string {
  try {
    const res = spawnSync(cmd, ["--version"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (res.error || res.status !== 0) return "missing";
    const out = ((res.stdout || "") + (res.stderr || "")).trim();
    return out.split(/\r?\n/)[0].slice(0, 40) || "ok";
  } catch {
    return "missing";
  }
}

/**
 * Каталог бинарников браузеров Playwright (env-переменная приоритетнее).
 * @returns путь к каталогу браузеров.
 */
export function playwrightBrowsersDir(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  return process.platform === "win32"
    ? join(homedir(), "AppData", "Local", "ms-playwright")
    : join(homedir(), ".cache", "ms-playwright");
}

/**
 * Наличие/версия пакета Playwright + скачаны ли бинарники браузеров.
 * @returns installed/version/browsersDir/browsersInstalled.
 */
export function playwrightInfo(): {
  installed: boolean;
  version: string;
  browsersDir: string;
  browsersInstalled: boolean;
} {
  let installed = false;
  let version = "";
  const browsersDir = playwrightBrowsersDir();
  try {
    // Правило №12: резолв с диска в рантайме — работает и в src/, и в dist/,
    // и под Bun, и под Node (мост тоже через createRequire).
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("playwright/package.json");
    installed = existsSync(pkgPath);
    version = JSON.parse(readFileSync(pkgPath, "utf8")).version || "";
  } catch {
    installed = false;
  }
  let browsersInstalled = false;
  try {
    if (existsSync(browsersDir)) {
      browsersInstalled = readdirSync(browsersDir).some((d) => /chrom/i.test(d));
    }
  } catch {
    browsersInstalled = false;
  }
  return { installed, version, browsersDir, browsersInstalled };
}

/**
 * Чистая проверка требований — варнинги из отчёта, без сайд-эффектов.
 * @param report отчёт collectEnvironment; @returns список варнингов.
 */
export function checkEnvironmentRequirements(report: EnvironmentReport): string[] {
  const warnings: string[] = [];
  if (report.runtime.runtime === "node") {
    warnings.push(t("env.runtime_node", { version: report.runtime.nodeVersion }));
  }
  if (!report.runtime.engineOk) {
    warnings.push(
      t("env.runtime_old", {
        version: report.runtime.nodeVersion,
        engine: report.runtime.engine,
      }),
    );
  }
  if (report.tools.bun === "missing") {
    warnings.push(t("env.tool_missing", { tool: "bun" }));
  }
  if (report.tools.git === "missing") {
    warnings.push(t("env.tool_missing", { tool: "git" }));
  }
  if (report.features.browser && report.playwright) {
    if (!report.playwright.installed) {
      warnings.push(t("env.playwright_missing"));
    } else if (!report.playwright.browsersInstalled) {
      warnings.push(t("env.playwright_browsers_missing", { dir: report.playwright.browsersDir }));
    }
  }
  return warnings;
}

/**
 * Собирает полный отчёт об окружении (рантайм, ОС, тулы, провайдер).
 * @param opts configDir/baseDir/config/scanTools; @returns готовый отчёт.
 */
export function collectEnvironment(opts: {
  configDir: string;
  baseDir?: string;
  config?: AppConfig;
  scanTools?: boolean;
}): EnvironmentReport {
  const runtime = detectRuntime();
  const tools: Record<string, string> = {};
  if (opts.scanTools) {
    for (const tool of TOOL_CHECKS) tools[tool] = toolVersion(tool);
  }

  const provider = opts.config
    ? {
        model: opts.config.model,
        baseUrl: sanitizeUrl(opts.config.provider?.baseUrl || ""),
        contextWindow: opts.config.contextWindow,
        retry: {
          maxRetries: opts.config.retry?.maxRetries ?? 0,
          baseDelay: opts.config.retry?.baseDelay ?? 0,
          maxDelay: opts.config.retry?.maxDelay ?? 0,
          maxStreamRetries: opts.config.retry?.maxStreamRetries ?? 0,
          noDataTimeoutMs: opts.config.retry?.noDataTimeoutMs ?? 0,
        },
      }
    : null;

  const report: EnvironmentReport = {
    ts: new Date().toISOString(),
    mmaVersion: readMmaVersion(),
    runtime,
    os: {
      platform: platform(),
      arch: arch(),
      release: release(),
      hostname: hostname(),
      shell: env.SHELL || env.ComSpec || "unknown",
      home: homedir(),
      cwd: process.cwd(),
    },
    paths: { configDir: opts.configDir, baseDir: opts.baseDir || process.cwd() },
    tools,
    provider,
    features: { browser: Boolean(opts.config?.browser?.enabled) },
    playwright: playwrightInfo(),
    warnings: [],
  };
  report.warnings = checkEnvironmentRequirements(report);
  return report;
}

/**
 * Компактная строка для человека + полный отчёт в JSONL-лог.
 * @param report отчёт окружения; @param logger логгер сессии.
 */
export function logEnvironment(report: EnvironmentReport, logger: Logger): void {
  logger.info(
    `Environment: ${report.os.platform} ${report.os.arch} | ${report.runtime.runtime} ${report.runtime.runtimeVersion} (node ${report.runtime.nodeVersion}) | mma ${report.mmaVersion} | ${report.provider?.model ?? "no provider"}`,
  );
  logger.logStructured("environment", report as unknown as Record<string, unknown>);
}