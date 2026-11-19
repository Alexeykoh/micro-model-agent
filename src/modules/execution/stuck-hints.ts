/**
 * Хинты детектора застревания: по описанию шага, по последней ошибке и
 * альтернативный тул при рантайм-краше.
 *
 * Вынесено из `stuck-detector.ts` (правило 6): функции только читают
 * состояние `StuckTracker`.
 */
import { t } from "../../i18n/index";
import type { StuckTracker } from "./stuck-tracker";
import { primaryReason } from "./stuck-recovery";

/** Хинты по описанию шага + состояниям, ещё не покрытым recovery-сообщением. */
export function hints(tracker: StuckTracker): string[] {
  const out: string[] = [];
  const desc = tracker.currentStepDescription.toLowerCase();

  if (desc.includes("install") || desc.includes("npm") || desc.includes("pip")) {
    out.push(t("exec.hint_deps"));
  }
  if (desc.includes("test") || desc.includes("spec")) {
    out.push(t("exec.hint_test"));
  }
  if (desc.includes("build") || desc.includes("compile")) {
    out.push(t("exec.hint_build"));
  }
  if (desc.includes("deploy") || desc.includes("publish")) {
    out.push(t("exec.hint_deploy"));
  }

  // State-based буллеты. Recovery-сообщение (recoveryMessage) уже репортит
  // ПЕРВИЧНУЮ причину (приоритет: stuck > tool-errors > bash-flailing >
  // consecutive > repetitive). Дублировать то же состояние хинтом — задвоить
  // гайданс в одном cooldown-блоке. Буллет добавляем, только если recovery
  // это состояние НЕ покрывает.
  const primary = primaryReason(tracker);
  if (tracker.hasRepetitiveToolCalls() && primary !== "repetitive") {
    out.push(t("exec.hint_repetitive"));
  }
  if (tracker.hasConsecutiveFailures() && primary !== "consecutive") {
    out.push(t("exec.hint_consecutive"));
  }
  return out;
}

/** Actionable-хинты по последней ошибке: рантаймы, синтаксис, сеть, шелл-несоответствия. */
export function actionableHints(tracker: StuckTracker): string[] {
  const out: string[] = [];
  const obs = tracker.observations;
  const error = tracker.lastErrorOutput;

  // Bash-хинты от фейла тула не зависят — срабатывают, даже когда команда
  // "успешна" с пустым выводом (потерянный entry point).
  const isScriptRun =
    /(^|[\s&])(bun|node|tsx|ts-node|deno|python|python3)\S*\s+[^|&]+\s+[^\s]+$/.test(
      obs.lastBashCommand,
    );
  if (isScriptRun && !obs.lastBashOutput.trim() && obs.emptyBashRunCount >= 2) {
    out.push(
      `The command "${obs.lastBashCommand}" ran ${obs.emptyBashRunCount} times with EMPTY output. The program likely has no entry point — read the file with read_file and check that it actually calls its main function with process.argv / CLI arguments and prints results (console.log). Then run it again.`,
    );
  }

  if (!error) return out;

  // Несовместимость рантайма — тул/модуль крашится на этой версии Node
  if (/Cannot read properties of undefined|is not a function|is not a constructor/i.test(error)) {
    if (/node_modules/.test(error)) {
      out.push(
        "A dependency is incompatible with your Node.js version. Check if there is an alternative package or use a different runtime.",
      );
    }
  }

  // Синтаксические ошибки TypeScript — модель сгенерила невалидный код
  if (/TS1005|TS1003|TS1109|TS1128|TS1434/i.test(error)) {
    out.push(
      "TypeScript syntax error. Read the error message carefully — it tells you the exact line and column. Fix the syntax before retrying.",
    );
  }

  // Ошибки типов TypeScript — модель не понимает типы
  if (/TS2322|TS2345|TS2769|TS7006|TS7016/i.test(error)) {
    out.push(
      "TypeScript type mismatch. Check the type signature of the function/API you are using. If a package lacks type declarations, install @types/<package> or use skipLibCheck.",
    );
  }

  // Модуль не найден — нет зависимости или неверный импорт
  if (/Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/i.test(error)) {
    out.push("Module not found. Run npm install or check if the import path is correct.");
  }

  // Ошибки прав доступа
  if (/EACCES|EPERM|permission denied/i.test(error)) {
    out.push("Permission denied. Check file permissions or run with appropriate privileges.");
  }

  // Сетевые ошибки
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(error)) {
    out.push("Network error. Check if the server is running and accessible.");
  }

  // Команда не найдена
  if (/is not recognized|command not found|not found in path/i.test(error)) {
    out.push("Command not found. Check if the tool is installed and in PATH.");
  }

  // Петля перезаписи: один файл безуспешно переписывается
  if (tracker.hasExcessiveRewrites()) {
    const file = tracker.getExcessiveRewriteFile();
    out.push(
      `File ${file} has been rewritten ${tracker.getFileRewriteCount(file!)} times without success. Stop rewriting and try a fundamentally different approach.`,
    );
  }

  // Повторные идентичные bash-прогоны с пустым выводом — вероятно, потерянный
  // entry point (программа не вызывает main).

  // PowerShell-командлеты внутри cmd.exe (шелл-несоответствие Windows).
  if (/Write-Host|Get-Content|Select-String|Out-File|Set-Content/i.test(error)) {
    out.push(
      "That looks like a PowerShell cmdlet — the shell here is cmd.exe. Use echo/type for output or the read_file/write_file tools instead.",
    );
  }

  // Модель выдумала несуществующий Bun API.
  if (
    /Bun\.\w+ is not a function|Bun\.\w+ is not defined|Bun\.\w+ is not a constructor/i.test(error)
  ) {
    out.push(
      "That Bun API does not exist. Verify the API name in the Bun docs — common ones are Bun.file, Bun.write, Bun.spawn, Bun.serve. For file checks use fs.existsSync from node:fs.",
    );
  }

  // Модель продолжает писать файл, в выводе которого type/syntax ошибка —
  // читай реальную ошибку и чини её, не переписывай вслепую.
  if (/error TS\d+|typecheck failed|syntax check failed/i.test(error)) {
    out.push(
      "The file still has a type/syntax error (see the error line in the output). Read the file with read_file around the reported line, fix the actual error, then re-run — rewriting the whole file blindly usually makes it worse.",
    );
  }

  // Bash-heredoc в cmd.exe.
  if (/unexpected.*<<|Непредвиденное появление/i.test(error)) {
    out.push(
      "Heredoc (<< EOF) is a bash feature — this shell is cmd.exe and does not support it. Write the file with write_file instead.",
    );
  }

  return out;
}

/** Альтернативный тул при рантайм-краше (ts-node→tsx, jest→vitest, …). Null, если нечего предложить. */
export function toolAlternative(tracker: StuckTracker): string | null {
  const tool = tracker.lastFailedTool;
  const error = tracker.lastErrorOutput;

  if (!tool) return null;

  // Упавший тул с рантайм-крашем — предлагаем альтернативы
  if (
    /Cannot read properties of undefined|is not a function|TypeError|ReferenceError/i.test(error)
  ) {
    // Карта упавших тулов на частые альтернативы
    const alternatives: Record<string, string> = {
      "ts-node": "tsx",
      jest: "vitest",
      mocha: "vitest",
      webpack: "vite",
      rollup: "vite",
      parcel: "vite",
      babel: "tsc",
      eslint: "biome",
      prettier: "biome",
    };

    for (const [failed, alt] of Object.entries(alternatives)) {
      if (tool.includes(failed) || error.includes(failed)) {
        return alt;
      }
    }
  }

  return null;
}
