/**
 * Факты окружения для системного промпта (спека `2026-10-31-system-prompt-v3`).
 *
 * Промпт не должен утверждать то, чего не знает: наличие `bun` в PATH, shell
 * инструмента, подключённость MCP, доступность LSP. Здесь — единственный вход,
 * собранный из `EnvironmentReport`, конфига и локального времени.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AppConfig } from "../config/types";
import type { EnvironmentReport } from "./environment";

/** Наличие команды в PATH (а не рантайма самого MMA). */
export type ToolPresence = "present" | "missing" | "unknown";

/** Shell, который реально использует тул `bash` (cmd.exe на Windows, sh на POSIX). */
export type PromptShell = "cmd" | "bash" | "sh" | "unknown";

/** Платформа из отчёта окружения. */
export type PromptPlatform = "win32" | "linux" | "darwin" | "unknown";

/** Пакетный менеджер проекта. */
export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

/** Факты, от которых зависит текст системного промпта. */
export interface PromptEnvironmentFacts {
  baseDir: string;
  platform: PromptPlatform;
  shell: PromptShell;
  runtime: "bun" | "node" | "unknown";
  tools: { bun: ToolPresence; git: ToolPresence; python: ToolPresence };
  project: {
    packageManager?: PackageManager;
    testCommand?: string;
    typecheckCommand?: string;
    languages: string[];
  };
  mcp: { configured: string[]; connected: string[] };
  /**
   * B6: `hasServer` — подтверждённый сервер, НЕ копия `enabled`. Факты
   * собираются до старта LSP, поэтому оба конструктора ставят `false`;
   * `true` ставит только тот, кто реально видел сервер (задача B14).
   */
  lsp: { enabled: boolean; hasServer: boolean };
  activeToolTags: string[];
  autoPlan: boolean;
  security: AppConfig["security"];
  now: { iso: string; timeZone: string; utcOffset: string };
}

/** Вход сборки фактов: отчёт окружения уже собран фазой workspace. */
export interface PromptFactsInput {
  config: AppConfig;
  baseDir: string;
  envReport: EnvironmentReport;
  activeToolTags?: string[];
}

/** Локальное время с явным offset: UTC без метки вводит модель в заблуждение. */
export function localNow(date = new Date()): PromptEnvironmentFacts["now"] {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const utcOffset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const iso =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${utcOffset}`;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  return { iso, timeZone, utcOffset };
}

/** `present` для версии/пути, `missing` для явного `missing`, иначе unknown. */
function toolPresence(value: string | undefined): ToolPresence {
  if (!value) return "unknown";
  return value === "missing" ? "missing" : "present";
}

/** Пакетный менеджер по lock-файлу; порядок — от самого специфичного. */
export function detectPackageManager(baseDir: string): PackageManager | undefined {
  if (existsSync(join(baseDir, "bun.lock")) || existsSync(join(baseDir, "bun.lockb"))) {
    return "bun";
  }
  if (existsSync(join(baseDir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(baseDir, "yarn.lock"))) return "yarn";
  if (existsSync(join(baseDir, "package-lock.json"))) return "npm";
  return undefined;
}

/** Читает `scripts` из package.json; битый/отсутствующий файл — пусто. */
function readPackageScripts(baseDir: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(baseDir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return raw.scripts ?? {};
  } catch {
    return {};
  }
}

/** Команда запуска скрипта для пакетного менеджера. */
function runScript(pm: PackageManager, script: string, isTest: boolean): string {
  if (isTest && script === "test") {
    return pm === "bun" ? "bun test" : pm === "npm" ? "npm test" : `${pm} test`;
  }
  if (pm === "bun") return `bun run ${script}`;
  if (pm === "npm") return `npm run ${script}`;
  return `${pm} ${script}`;
}

/** Проектные команды: тест и typecheck из package.json, без выдуманных имён. */
export function detectProjectCommands(
  baseDir: string,
  pm: PackageManager | undefined,
): { testCommand?: string; typecheckCommand?: string } {
  const scripts = readPackageScripts(baseDir);
  const testScript = scripts.test ? "test" : undefined;
  const typecheckScript = scripts.typecheck
    ? "typecheck"
    : scripts["type-check"]
      ? "type-check"
      : undefined;
  const testCommand =
    pm && testScript ? runScript(pm, testScript, true) : undefined;
  const hasLocalTsc =
    existsSync(join(baseDir, "node_modules", "typescript", "bin", "tsc")) ||
    existsSync(join(baseDir, "node_modules", ".bin", "tsc"));
  const typecheckCommand =
    pm && typecheckScript
      ? runScript(pm, typecheckScript, false)
      : hasLocalTsc && existsSync(join(baseDir, "tsconfig.json"))
        ? "tsc --noEmit"
        : undefined;
  return { testCommand, typecheckCommand };
}

/** Платформа из отчёта; неизвестная — `unknown`, а не догадка. */
function detectPlatform(envReport: EnvironmentReport): PromptPlatform {
  const p = envReport.os.platform.toLowerCase();
  if (p.includes("win32") || p.includes("windows")) return "win32";
  if (p.includes("darwin") || p.includes("mac")) return "darwin";
  if (p.includes("linux")) return "linux";
  return "unknown";
}

/**
 * Собирает факты для промпта.
 * @param input конфиг, workspace и уже собранный отчёт окружения.
 * @returns факты, из которых `buildSystemInfo` строит текст.
 */
export function collectPromptFacts(input: PromptFactsInput): PromptEnvironmentFacts {
  const { config, baseDir, envReport } = input;
  const platform = detectPlatform(envReport);
  // Shell — именно тот, которым исполняет `bash`-тул: на Windows это cmd.exe,
  // на POSIX — sh. Терминал пользователя (Git Bash/PowerShell) сюда не входит.
  const shell: PromptShell = platform === "win32" ? "cmd" : platform === "unknown" ? "unknown" : "sh";
  const packageManager = detectPackageManager(baseDir);
  const commands = detectProjectCommands(baseDir, packageManager);
  const mcpConfigured = Object.entries(config.mcpServers ?? {})
    .filter(([, server]) => server.enabled !== false)
    .map(([name]) => name);
  // B6: hasServer — НЕ равен enabled. Факты собираются до старта LSP-модуля
  // (workspace-фаза раньше modules-фазы), состояние сервера неизвестно —
  // честно false («не подтверждён»), а не копия флага. Промпт решает по паре
  // (enabled, hasServer), чтобы не слать модель в `lsp_check` без сервера.
  const lspEnabled = config.lsp?.enabled ?? true;

  return {
    baseDir,
    platform,
    shell,
    runtime: envReport.runtime.runtime,
    tools: {
      bun: toolPresence(envReport.tools.bun),
      git: toolPresence(envReport.tools.git),
      python: toolPresence(envReport.tools.python),
    },
    project: {
      packageManager,
      testCommand: commands.testCommand,
      typecheckCommand: commands.typecheckCommand,
      languages: [],
    },
    mcp: { configured: mcpConfigured, connected: [] },
    // B6: сервер на момент фактов ещё не стартовал — `false`, заполнение
    // реальным состоянием после LSP-probe — задача B14 (статика stale).
    lsp: { enabled: lspEnabled, hasServer: false },
    activeToolTags: input.activeToolTags ?? config.tools?.defaultTags ?? [],
    autoPlan: config.autoPlan,
    security: config.security,
    now: localNow(),
  };
}

/**
 * Факты-заглушка для вызовов без отчёта окружения (тесты, старые поверхности).
 * Ничего не утверждает о наличии Bun/команд: `unknown`/пусто.
 * @param config конфиг; @param baseDir workspace; @param profile сжатый профиль.
 */
export function fallbackPromptFacts(
  config: AppConfig,
  baseDir: string,
  profile: string,
): PromptEnvironmentFacts {
  // B7: платформа — из `process.platform`, а не из угадайки по строке профиля
  // (`"darwin"` в имени профиля — не macOS). Параметр `profile` оставлен для
  // совместимости сигнатуры; платформа машины от него не зависит.
  void profile;
  const platform: PromptPlatform =
    process.platform === "win32"
      ? "win32"
      : process.platform === "darwin"
        ? "darwin"
        : process.platform === "linux"
          ? "linux"
          : "unknown";
  const shell: PromptShell = platform === "win32" ? "cmd" : platform === "unknown" ? "unknown" : "sh";
  return {
    baseDir,
    platform,
    shell,
    runtime: (globalThis as { Bun?: unknown }).Bun ? "bun" : "node",
    tools: { bun: "unknown", git: "unknown", python: "unknown" },
    project: { languages: [] },
    mcp: {
      configured: Object.entries(config.mcpServers ?? {})
        .filter(([, server]) => server.enabled !== false)
        .map(([name]) => name),
      connected: [],
    },
    // B6: вне bootstrap состояние сервера неизвестно — честно false.
    lsp: { enabled: config.lsp?.enabled ?? true, hasServer: false },
    activeToolTags: config.tools?.defaultTags ?? [],
    autoPlan: config.autoPlan,
    security: config.security,
    now: localNow(),
  };
}
