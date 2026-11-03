/** Тул shell-команд: автофон, редирект tool-call, хинты Windows, мемо read-only. */
import type { ToolDefinition, ToolContext } from "./types";
import { isCommandAllowed, sanitizeCommandForLog } from "../modules/security/command-validator";
import { logBashCommand, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { assertWorkdirAllowed, echoWriteHint, posixWorkdirHint } from "./path-guards";
import { DEFAULT_SECURITY_CONFIG } from "../config/security";
import type { BashSecurityConfig } from "../config/types";
import { t } from "../i18n/index";
import { platform } from "os";
import { buildBashDescription } from "./bash-description";
import {
  NEVER_TOOL_CALLS,
  adaptCommandForWindows,
  detectToolCallInBash,
  extractEchoFileWrite,
  parseToolArgs,
} from "./bash-parse";
import { isMemoizableCommand, memoClear, memoRead } from "./bash-memo";
import { runBashCommand } from "./bash-process";

// Публичные ре-экспорты: тесты и смежные модули импортируют их из `bash`.
export { BASH_GRACE_MS, setBashGraceMs } from "./bash-process";
export { resetBashFailureTracking } from "./bash-failures";
export {
  detectTestResults,
  emptyCliRunHint,
  interactivePromptHint,
  npmExecHint,
  type TestRunSummary,
} from "./bash-output";
export {
  detectToolCallInBash,
  extractEchoFileWrite,
  parseToolArgs,
  translateSemicolonsForCmd,
} from "./bash-parse";
export { isMemoizableCommand } from "./bash-memo";

/** Тулы управления процессами за enable_tools (тег "shell"). */
const HIDDEN_PROCESS_TOOLS = ["process_list", "process_log", "process_kill", "process_wait"];

/**
 * Разрешение bash-security-конфига: session-изоляция поверх глобального,
 * мастер-выключатель `enabled: false` гасит все под-модули.
 */
function resolveBashSecurityConfig(ctx: ToolContext): BashSecurityConfig {
  const appConfig = ctx.config || {};
  const fullSecurityConfig = ctx.sessionContext
    ? getSessionSecurityConfig(appConfig, ctx.sessionContext)
    : appConfig.security || DEFAULT_SECURITY_CONFIG;
  return fullSecurityConfig.enabled === false
    ? { ...(fullSecurityConfig.bash || DEFAULT_SECURITY_CONFIG.bash), enabled: false }
    : fullSecurityConfig.bash || DEFAULT_SECURITY_CONFIG.bash;
}

export const bashTool: ToolDefinition = {
  name: "bash",
  security: { caps: [{ proc: true }], manual: { reason: "shell — command-validator в хендлере", reviewedBy: "architecture-v2", date: "2026-10-13" } },
  icon: "💻",
  description: buildBashDescription(),
  tags: ["shell", "code"],
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      workdir: {
        type: "string",
        description: "Working directory (default: baseDir)",
      },
      background: {
        type: "boolean",
        description:
          "Return a process id immediately without waiting (default: commands still running after a few seconds are auto-promoted to the background)",
      },
      force: {
        type: "boolean",
        description:
          "Start a new process even if an identical command is already running (default: reuse the running one)",
      },
    },
    required: ["command"],
  },
  /** Мемоизация покомандно (см. isMemoizableCommand) — ведётся здесь. */
  manualMemo: true,
  handler: async (ctx, args) => {
    const originalCommand = String(args.command);

    // Модель иногда шлёт вызов тула (напр. "create_dir path=…") командой bash
    // вместо прямого вызова. Редирект в настоящий тул — намерение сработает,
    // а не упадёт в шелле.
    const toolCall = detectToolCallInBash(originalCommand);
    if (
      toolCall &&
      toolCall.tool !== "bash" &&
      ctx.toolExecutor?.hasTool(toolCall.tool)
    ) {
      const redirected = await ctx.toolExecutor.executeByName(
        toolCall.tool,
        parseToolArgs(toolCall.args),
        ctx,
      );
      return {
        success: redirected.success,
        output: `[redirected to tool "${toolCall.tool}"]\n${redirected.output}`,
      };
    }

    const command = adaptCommandForWindows(originalCommand);

    // Discovery скрытых тулов: при сужении набора process_* невидимы модели, и
    // прогон через cmd.exe даёт лишь "is not recognized" — указать на enable_tools.
    const baseCmd = originalCommand.trim().split(/\s+/)[0];
    if (
      HIDDEN_PROCESS_TOOLS.includes(baseCmd) &&
      ctx.toolExecutor?.hasTool?.(baseCmd)
    ) {
      return {
        success: false,
        output: t("exec.hidden_tool_hint", { tool: baseCmd }),
      };
    }

    // Обобщённый редирект tool-as-command: команда начинается с имени
    // зарегистрированного тула (без k=v, иначе пойман выше). Настоящие
    // shell-команды (grep/cat/…) исключены NEVER_TOOL_CALLS.
    if (
      baseCmd &&
      !NEVER_TOOL_CALLS.has(baseCmd) &&
      ctx.toolExecutor?.hasTool?.(baseCmd)
    ) {
      return {
        success: false,
        output: t("exec.tool_as_command_hint", { tool: baseCmd }),
      };
    }

    // Generic `--cwd` → параметр workdir: флаг не является стандартным для
    // большинства CLI (модель изобретала `bun run build --cwd`).
    if (/(?:^|\s)--cwd(?:[=\s]|$)/.test(originalCommand)) {
      return {
        success: false,
        output: t("bash.cwd_flag_hint", { workdir: ctx.baseDir }),
      };
    }

    // echo/printf-редирект в файл ненадёжен в cmd.exe — вести на write_file.
    const echoHint = echoWriteHint(platform() === "win32" ? extractEchoFileWrite(originalCommand) : undefined);
    if (echoHint) return { success: false, output: echoHint };

    const workdir = args.workdir ? String(args.workdir) : ctx.baseDir;

    // POSIX-workdir на Windows: cmd.exe не понимает "/tmp"/"/Users/…" — даём
    // корректирующий хинт вместо непонятной ошибки spawn.
    const posixHint = posixWorkdirHint(workdir, ctx.baseDir);
    if (posixHint) return { success: false, output: posixHint };

    // Workdir-jail (аудит §4.1): рабочий каталог — внутри baseDir и внутри
    // скоупа субагента. Иначе модель одной командой уходит за пределы проекта.
    const workdirBlocked = assertWorkdirAllowed(ctx, workdir);
    if (workdirBlocked) return workdirBlocked;

    // Session-specific security config (мастер-выключатель учтён внутри).
    const securityConfig = resolveBashSecurityConfig(ctx);
    // Валидируем ИСХОДНУЮ: win32 переводит `;`→`&` до проверки, обходя блок «;»-цепочек.
    const validation = isCommandAllowed(originalCommand, securityConfig);

    if (!validation.allowed) {
      logSecurityBlock(
        ctx.sessionId,
        "bash_command",
        validation.reason || "Command blocked by security policy",
        sanitizeCommandForLog(originalCommand),
      );

      return {
        success: false,
        output: `[SECURITY BLOCKED] Command is not allowed: ${validation.reason}\nHint: run one plain command per tool call. For output redirection write the file with write_file; for chaining run separate calls; use the "workdir" parameter instead of "cd dir && cmd". Do NOT write a wrapper script (.bat/.cmd/.sh/.ps1) to bypass this — the same rule applies when that script runs.`,
      };
    }

    // Лог запуска команды, если включён.
    if (securityConfig?.logCommands) {
      logBashCommand(
        ctx.sessionId,
        sanitizeCommandForLog(command),
        false, // Will be updated after execution
        `Working directory: ${workdir}`,
      );
    }

    // Мемо результата (manualMemo, после security-гейта, чтобы блок никогда не
    // маскировался stored-результатом): одиночные read-only отдаются из мемо
    // исполнителя; всё остальное его сбрасывает. Фоновые запуски не мемоизируются
    // (process id одноразовые).
    const memoKey = { command, workdir };
    const memoizable = args.background !== true && isMemoizableCommand(command);
    if (memoizable) {
      const hit = memoRead(ctx, memoKey);
      if (hit) return { ...hit };
    } else {
      memoClear(ctx);
    }

    return runBashCommand({
      ctx,
      command,
      originalCommand,
      workdir,
      explicitBackground: args.background === true,
      force: args.force === true,
      securityConfig,
      memoizable,
      memoKey,
    });
  },
};
