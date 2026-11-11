/**
 * Исполнение bash-команды и фоновые процессы: старт, окно автобэкграунда,
 * регистрация killable, вывод результата. Вынесено из `bash.ts` (правило 6).
 * Security-гейт остаётся в хендлере/`ToolExecutor` — здесь только запуск уже
 * разрешённой команды.
 */
import type { ToolContext, ToolResult } from "./types";
import { t } from "../i18n/index";
import { platform } from "os";
import {
  BASH_GRACE_MS as CANONICAL_BASH_GRACE_MS,
  /** Короткое окно для явного `background: true` — ловит ошибки спавна. */
  BASH_SPAWN_SETTLE_MS as SPAWN_SETTLE_MS,
} from "../config/timeouts";
import { processRegistry, registerKillable, unregisterKillable } from "../modules/processes";
import { sanitizeCommandForLog } from "../modules/security/command-validator";
import { logBashCommand } from "../modules/security/audit-log";
import type { BashSecurityConfig } from "../config/types";
import { decorateCommandOutput, detectTestResults } from "./bash-output";
import { memoWrite } from "./bash-memo";
import {
  SHELL_UNAVAILABLE_ERROR_CODE,
  classifySpawnError,
  shellUnavailableOutput,
} from "./bash-spawn-error";
import {
  SHELL_STOP_THRESHOLD,
  recordShellUnavailable,
  resetShellUnavailable,
  shellUnavailableStreak,
} from "./bash-failures";

/**
 * Команда, живая после окна ожидания, уходит в фон. Решение — по поведению
 * процесса (всё ещё жив), а не по словам в тексте: упоминание "vite"/"server"
 * выполняется обычно, а любая реально долгая команда ловится как ни пиши.
 */
/** Публичный экспорт-алиас: то же значение из реестра (используют тесты). */
export const BASH_GRACE_MS = CANONICAL_BASH_GRACE_MS;
/** Строк уже выданного вывода в стартовом сообщении фона. */
const BG_OUTPUT_PREVIEW_LINES = 15;

let bashGraceMs = BASH_GRACE_MS;
/** Тестовый хук: переопределить окно автобэкграунда. */
export function setBashGraceMs(ms: number): void {
  bashGraceMs = ms;
}

export interface RunBashCommandOptions {
  ctx: ToolContext;
  /** Команда после Windows-адаптации — исполняется. */
  command: string;
  /** Исходная команда модели — для хинтов/аудита. */
  originalCommand: string;
  workdir: string;
  explicitBackground: boolean;
  force: boolean;
  securityConfig: BashSecurityConfig;
  memoizable: boolean;
  memoKey: Record<string, unknown>;
}

/** Запускает разрешённую команду, ждёт окно и отдаёт результат/фон. */
export async function runBashCommand(opts: RunBashCommandOptions): Promise<ToolResult> {
  const { ctx, command, originalCommand, workdir, securityConfig, memoizable, memoKey } = opts;

  // S1: два подряд «шелл недоступен» — третий спавн не вызываем, он заведомо
  // упадёт. Итерации жалеть нечем: причина на машине, а не в команде.
  if (shellUnavailableStreak(ctx) >= SHELL_STOP_THRESHOLD - 1) {
    return {
      success: false,
      output: shellUnavailableOutput(),
      errorMeta: { code: SHELL_UNAVAILABLE_ERROR_CODE, retryable: false },
    };
  }

  const entry = processRegistry.start(command, workdir, ctx.sessionId, {
    force: opts.force,
  });
  if (ctx.activeCallId) {
    // Исполнителю — убить дочерний процесс в grace-окне при аборте.
    registerKillable(ctx.activeCallId, () => processRegistry.kill(entry.id), ctx.sessionId);
  }

  try {
    const settleMs = opts.explicitBackground ? SPAWN_SETTLE_MS : bashGraceMs;
    const exited = await processRegistry.waitForExit(entry.id, settleMs);

    if (exited) {
      // Команда уложилась в окно (включая ошибку спавна).
      if (entry.spawnError) {
        // S1: различаем «сломан шелл» и «плохой workdir» — раньше оба получали
        // ложный совет проверить workdir (сломанный шелл не чинится workdir).
        if (classifySpawnError(entry.spawnError, platform(), workdir) === "shell") {
          recordShellUnavailable(ctx);
          return {
            success: false,
            output: shellUnavailableOutput(entry.spawnError),
            errorMeta: { code: SHELL_UNAVAILABLE_ERROR_CODE, retryable: false },
          };
        }
        return {
          success: false,
          output: `[process error] ${entry.spawnError}\nHint: check the "workdir" path exists and the command is valid for this OS.`,
        };
      }

      const code = entry.exitCode;
      let output = entry.log.join("\n");
      processRegistry.remove(entry.id);

      // Шелл снова работает — снимаем серию «шелл недоступен».
      if (code === 0) {
        resetShellUnavailable(ctx);
      }

      // Подсказки, аудит и обрезка вывода — единая точка (decorateCommandOutput).
      const testRun = detectTestResults(output);
      output = decorateCommandOutput({
        ctx,
        command,
        originalCommand,
        code,
        output,
        testRun,
        workdir,
        securityConfig,
      });

      // Успешные read-only прогоны — в мемо (падения могут быть транзиентны).
      if (memoizable && code === 0) {
        memoWrite(ctx, memoKey, { success: true, output });
      }
      return { success: code === 0, output };
    }

    // Всё ещё жива — в фоновые процессы. Процесс стартовал, значит шелл работает.
    resetShellUnavailable(ctx);
    const preview = entry.log
      .filter((l) => l.trim() !== "")
      .slice(0, BG_OUTPUT_PREVIEW_LINES)
      .join("\n");
    let output = `${t("proc.started", {
      id: entry.id,
      pid: entry.pid,
      command,
    })}${opts.explicitBackground ? "" : `\n${t("proc.promoted_hint", { ms: settleMs })}`}`;
    if (preview) {
      output += `\n\n${t("proc.output_preview", { lines: preview })}`;
    }
    output += `\n${t("proc.manage_hint", { id: entry.id })}`;

    if (securityConfig?.logCommands) {
      logBashCommand(
        ctx.sessionId,
        sanitizeCommandForLog(command),
        true,
        `Started in background: ${entry.id} (PID ${entry.pid})`,
      );
    }

    return { success: true, output };
  } finally {
    if (ctx.activeCallId) {
      unregisterKillable(ctx.activeCallId, ctx.sessionId);
    }
  }
}
