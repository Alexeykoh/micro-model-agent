import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { execSync } from "node:child_process";

/**
 * Хуки жизненного цикла инструментов.
 *
 * Позволяют выполнять пользовательские команды до/после вызова инструментов:
 * - preToolUse: перед вызовом любого инструмента
 * - postToolUse: после вызова любого инструмента
 * - postEdit: после записи/редактирования файла
 *
 * Конфигурация в .mma/hooks.json или .mmrc (секция hooks).
 * Хуки могут блокировать выполнение (exit code 1).
 *
 * Доступные переменные в шаблонах:
 * - {{tool}} — имя инструмента
 * - {{cmd}} — команда/аргументы
 * - {{file}} — путь к файлу
 * - {{output}} — вывод (postToolUse)
 * - {{exitCode}} — код возврата (postToolUse)
 * - {{cwd}} — текущая директория
 *
 * @module tools/hooks
 */

/** Конфигурация хуков из .mma/hooks.json */
export interface HookConfig {
  preToolUse?: string[];
  postToolUse?: string[];
  postEdit?: string[];
}

/** Результат выполнения хука: continue (продолжить) или блокировка */
interface HookResult {
  continue: boolean;
  message?: string;
}

const DEFAULT_HOOKS: HookConfig = {};

/** Загружает конфигурацию хуков из .mma/hooks.json или .mmrc */
function loadHooksConfig(cwd: string): HookConfig {
  // Check .mma/hooks.json
  const localPath = join(cwd, ".mma", "hooks.json");
  if (existsSync(localPath)) {
    try {
      return {
        ...DEFAULT_HOOKS,
        ...JSON.parse(readFileSync(localPath, "utf-8")),
      };
    } catch {
      /* ignore */
    }
  }

  // Check .mmrc hooks section
  const rcPath = join(cwd, ".mmrc");
  if (existsSync(rcPath)) {
    try {
      const rc = JSON.parse(readFileSync(rcPath, "utf-8"));
      if (rc.hooks) return { ...DEFAULT_HOOKS, ...rc.hooks };
    } catch {
      /* ignore */
    }
  }

  return DEFAULT_HOOKS;
}

/** Выполняет одну hook-команду с подстановкой переменных */
function runHook(command: string, context: Record<string, string>): HookResult {
  try {
    // Replace {{variable}} placeholders
    let cmd = command;
    for (const [key, value] of Object.entries(context)) {
      cmd = cmd.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: 10000,
      cwd: context.cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    return { continue: true, message: output.trim() };
  } catch (e: any) {
    // Hook failed - check exit code
    if (e.status === 1) {
      return { continue: false, message: e.stderr || e.message };
    }
    return { continue: true, message: `[hook error: ${e.message}]` };
  }
}

/** Запуск хуков перед вызовом инструмента. Возвращает false для блокировки. */
export function runPreToolUseHooks(
  cwd: string,
  toolName: string,
  cmd: string,
): HookResult {
  const config = loadHooksConfig(cwd);
  if (!config.preToolUse || config.preToolUse.length === 0) {
    return { continue: true };
  }

  const context = { cwd, tool: toolName, cmd, file: cmd };

  for (const hook of config.preToolUse) {
    const result = runHook(hook, context);
    if (!result.continue) {
      return result;
    }
  }

  return { continue: true };
}

/** Запуск хуков после вызова инструмента (с выводом и кодом возврата) */
export function runPostToolUseHooks(
  cwd: string,
  toolName: string,
  cmd: string,
  output: string,
  exitCode: number,
): HookResult {
  const config = loadHooksConfig(cwd);
  if (!config.postToolUse || config.postToolUse.length === 0) {
    return { continue: true };
  }

  const context = {
    cwd,
    tool: toolName,
    cmd,
    output: output.slice(0, 1000),
    exitCode: exitCode.toString(),
    file: cmd,
  };

  for (const hook of config.postToolUse) {
    const result = runHook(hook, context);
    if (!result.continue) {
      return result;
    }
  }

  return { continue: true };
}

/** Запуск хуков после записи/редактирования файла */
export function runPostEditHooks(cwd: string, filePath: string): HookResult {
  const config = loadHooksConfig(cwd);
  if (!config.postEdit || config.postEdit.length === 0) {
    return { continue: true };
  }

  const context = { cwd, file: filePath, cmd: "" };

  for (const hook of config.postEdit) {
    const result = runHook(hook, context);
    if (!result.continue) {
      return result;
    }
  }

  return { continue: true };
}

/** Возвращает список всех зарегистрированных хуков */
export function listHooks(cwd: string): string[] {
  const config = loadHooksConfig(cwd);
  const hooks: string[] = [];

  if (config.preToolUse)
    hooks.push(...config.preToolUse.map((h) => `[pre] ${h}`));
  if (config.postToolUse)
    hooks.push(...config.postToolUse.map((h) => `[post] ${h}`));
  if (config.postEdit) hooks.push(...config.postEdit.map((h) => `[edit] ${h}`));

  return hooks;
}

// ─── Builtin hooks (replaces old PluginManager) ─────────────────

const LINTER_DETECT_COMMANDS = [
  { name: "eslint", cmd: "npx eslint --version" },
  { name: "biome", cmd: "npx @biomejs/biome --version" },
  { name: "prettier", cmd: "npx prettier --version" },
];

let cachedLinter: string | null = null;

function detectLinter(cwd: string): string | null {
  for (const { name, cmd } of LINTER_DETECT_COMMANDS) {
    try {
      execSync(cmd, { cwd, timeout: 5000, windowsHide: true, stdio: "pipe" });
      cachedLinter = name;
      return name;
    } catch {}
  }
  return null;
}

function runLinter(
  linter: string,
  filePath: string,
  cwd: string,
): string | null {
  try {
    let cmd: string;
    switch (linter) {
      case "eslint":
        cmd = `npx eslint "${filePath}" --format compact`;
        break;
      case "biome":
        cmd = `npx @biomejs/biome check "${filePath}"`;
        break;
      case "prettier":
        cmd = `npx prettier --check "${filePath}"`;
        break;
      default:
        return null;
    }
    execSync(cmd, {
      cwd,
      timeout: 15000,
      windowsHide: true,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return null;
  } catch (e: any) {
    const output = e.stdout?.toString() || e.stderr?.toString() || "";
    return output ? output.slice(0, 1000) : null;
  }
}

export function runLintAfterWrite(
  cwd: string,
  filePath: string,
): string | null {
  if (!filePath || !/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) return null;
  const linter = cachedLinter ?? detectLinter(cwd);
  if (!linter) return null;
  return runLinter(linter, filePath, cwd);
}

export function sendNotification(title: string, body: string): void {
  const p = platform();
  try {
    if (p === "win32") {
      const safeTitle = title.replace(/'/g, "''");
      const safeBody = body.replace(/'/g, "''");
      const psScript = `Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(5000, '${safeTitle}', '${safeBody}', [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Seconds 2
$n.Dispose()`;
      const tmpFile = join(tmpdir(), `mma-notify-${Date.now()}.ps1`);
      writeFileSync(tmpFile, psScript, "utf-8");
      try {
        execSync(`powershell -ExecutionPolicy Bypass -File "${tmpFile}"`, {
          timeout: 8000,
          windowsHide: true,
          stdio: "pipe",
        });
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {}
      }
    } else if (p === "darwin") {
      execSync(
        `osascript -e 'display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"'`,
        { timeout: 5000, stdio: "pipe" },
      );
    } else {
      execSync(
        `notify-send "${title.replace(/"/g, '\\"')}" "${body.replace(/"/g, '\\"')}"`,
        { timeout: 5000, stdio: "pipe" },
      );
    }
  } catch {}
}
