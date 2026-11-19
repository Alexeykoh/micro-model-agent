/**
 * Форматирование вывода bash: хинты, сводка тест-ранов, аудит-обрезка.
 * Вынесено из `bash.ts` (правило 6). Поведение то же: декорация не принимает
 * security-решений, только объясняет результат модели.
 */
import type { ToolContext } from "./types";
import { t } from "../i18n/index";
import { platform } from "os";
import { MAX_PREVIEW_LINES } from "./preview";
import { sanitizeCommandForLog } from "../modules/security/command-validator";
import { logBashCommand } from "../modules/security/audit-log";
import type { BashSecurityConfig } from "../config/types";
import { HARD_BLOCK_THRESHOLD, failureCounters } from "./bash-failures";

/** Типовой маппинг Unix → Windows для хинтов об ошибках. */
export const UNIX_TO_WIN_HINTS: Record<string, string> = {
  ls: "Use the list_dir tool instead.",
  pwd: "Use the file_info tool instead.",
  cat: "Use the read_file tool instead.",
  cp: "Use the move_file tool instead.",
  mv: "Use the move_file tool instead.",
  rm: "Use the delete_file tool instead.",
  grep: "Use the grep tool instead.",
  sed: "Use the edit_file tool instead.",
  awk: "Not available in cmd.exe. Use a Node.js one-liner or the grep tool instead.",
  chmod: "Use the chmod tool instead.",
  touch: "Use the write_file tool instead.",
  find: "Use the glob tool instead.",
  head: "Use the read_file tool with offset/limit instead.",
  tail: "Use the read_file tool instead.",
  wc: "Use the read_file tool instead.",
  uniq: "Not available in cmd.exe. Use a Node.js one-liner instead.",
  xargs: "Not available in cmd.exe. Use a Node.js one-liner instead.",
  cut: "Not available in cmd.exe. Use a Node.js one-liner instead.",
  tr: "Not available in cmd.exe. Use a Node.js one-liner instead.",
  basename: "Not available in cmd.exe. Use a Node.js one-liner instead.",
  dirname: "Not available in cmd.exe. Use a Node.js one-liner instead.",
  export: 'cmd.exe has no export - use "set VAR=value" (no spaces around =).',
  source: 'cmd.exe has no source - use "call script.bat".',
  sleep: 'Use "timeout /t N" instead.',
  env: "cmd.exe has no env - use set to list/set variables.",
  diff: "Use the diff tool instead.",
  which: 'Use "where" instead.',
  echo: "echo works on Windows, but avoid pipes (|).",
  "Get-Content": "Use the read_file tool instead.",
  "Select-Object": "Use the read_file tool with offset/limit instead.",
  "Write-Host": "PowerShell cmdlet — this shell is cmd.exe. Print with plain echo instead.",
  "Select-String": "Use the grep tool instead.",
  "Out-File": "Write files with the write_file tool instead.",
  "Set-Content": "Write files with the write_file tool instead.",
  "Get-ChildItem": "Use the list_dir tool instead.",
  "Remove-Item": "Use the delete_file tool instead.",
};

/** Сводка тест-рана: фреймворк, счёт, строка итога. */
export interface TestRunSummary {
  framework: string;
  /** Прошедших кейсов (когда раннер сообщает). */
  passed: number;
  /** Упавших кейсов. */
  failed: number;
  /** Строка агрегатного итога раннера, если есть. */
  summary?: string;
}

/**
 * Детект отчёта тест-раннера в выводе (bun test/vitest/jest/mocha/`go test`/
 * pytest). Не похоже на тесты — null. Нужно, чтобы вставить warning при
 * падениях и модель не закрыла шаг "прогнать тесты" как done.
 */
export function detectTestResults(output: string): TestRunSummary | null {
  if (!output) return null;

  // Сначала однозначные фреймворк-специфичные счётчики.
  const jest = output.match(/Tests:\s+(\d+)\s+passed,\s*(\d+)\s+failed/i);
  if (jest) {
    return { framework: "jest", passed: +jest[1], failed: +jest[2] };
  }
  const mochaPass = output.match(/(\d+)\s+passing/i);
  const mochaFail = output.match(/(\d+)\s+failing/i);
  if (mochaPass || mochaFail) {
    return {
      framework: "mocha",
      passed: mochaPass ? +mochaPass[1] : 0,
      failed: mochaFail ? +mochaFail[1] : 0,
    };
  }
  const pytest = output.match(/(\d+)\s+passed[^\n]*?(?:,\s*(\d+)\s+failed)?/i);
  if (
    pytest &&
    /pytest|passed|failed/i.test(output) &&
    /(=====|short test summary|tests\s+ok)/i.test(output) === false &&
    /pytest|collect/i.test(output)
  ) {
    return {
      framework: "pytest",
      passed: +pytest[1],
      failed: pytest[2] ? +pytest[2] : 0,
    };
  }

  // bun test / vitest: покейсные маркеры + хвостовое "N pass / M fail".
  const failMarkers = output.match(/\(fail\)/g)?.length ?? 0;
  const passMarkers = output.match(/\(pass\)/g)?.length ?? 0;
  const xMarkers = output.match(/\s×\s/g)?.length ?? 0;
  const summaryMatch = output.match(/^\s*(\d+)\s+pass[^\n]*$/m);
  const failSummary = output.match(/^\s*(\d+)\s+fail[^\n]*$/m);
  const ran = output.match(/(?:Ran|ran)\s+\d+\s+tests/i);

  if (failMarkers > 0 || passMarkers > 0 || xMarkers > 0 || ran) {
    const failed = Math.max(failMarkers + xMarkers, failSummary ? +failSummary[1] : 0);
    const passed = Math.max(passMarkers, summaryMatch ? +summaryMatch[1] : 0);
    return {
      framework: ran ? "bun/vitest" : "vitest",
      passed,
      failed,
      summary: summaryMatch?.[0] ?? failSummary?.[0],
    };
  }
  return null;
}

/**
 * R5: команда запуска скрипта (bun/node/python/…) вышла в 0, но молча.
 * Частая причина в агент-сессиях: нет точки входа — main() с CLI-аргументами
 * никто не вызывает. Конкретный хинт вместо молчаливого пустого вывода.
 */
const CLI_FILE_RUN_RE =
  /\b(bun|node|deno|python|python3|tsx|ts-node|php|ruby|go\s+run)\S*\s+(run\s+)?["']?[\w./\\-]+\.(ts|js|tsx|jsx|mjs|cjs|py)\b/;

/** Хинт на пустой прогон CLI-файла (код 0, stdout пуст). */
export function emptyCliRunHint(
  command: string,
  output: string,
  code: number | null,
): string | null {
  if (code !== 0 || output.trim()) return null;
  if (/[>|]/.test(command)) return null; // редирект/пайп — вывод ушёл мимо
  if (/\b(bun test|vitest|pytest|jest|mocha|--test)\b/i.test(command)) return null;
  if (!CLI_FILE_RUN_RE.test(command)) return null;
  return "the command exited 0 but printed NOTHING to stdout. If this should run a CLI program, the file probably has no entry point: read it with read_file and check the code actually calls its main function with command-line arguments (e.g. main(process.argv[2])) and prints results with console.log.";
}

/**
 * Детект npm/npx/bunx с "could not determine executable to run" — у пакета
 * нет `bin` (или `npm run <script>` назвал несуществующий скрипт). Конкретный
 * хинт вместо слепых ретраев (наблюдено в двух сессиях: модель жгла итерации
 * на повторах той же падающей команды).
 */
const NPM_EXEC_RE = /could not determine executable to run/i;

/**
 * Команда ждала интерактивного ввода без TTY и абортнулась ("Operation
 * cancelled" у Bun/Node или "stdin is not a TTY"). Типично для голых
 * `bun create`/`npm create`. Конкретное неинтерактивное лечение вместо
 * повтора той же команды.
 */
const INTERACTIVE_PROMPT_RE =
  /operation (?:cancelled|canceled|aborted)|stdin is not a tty|not a tty|cannot prompt without a tty/i;

/** Дописывает хинт на npm-без-bin (по выводу). */
export function npmExecHint(output: string): string {
  if (NPM_EXEC_RE.test(output)) {
    return `${output}\n\nHint: ${t("exec.npm_exec_hint")}`;
  }
  return output;
}

/** Дописывает неинтерактивное лечение при аборте на ожидании stdin. */
export function interactivePromptHint(output: string): string {
  if (INTERACTIVE_PROMPT_RE.test(output)) {
    return `${output}\n\nHint: ${t("exec.interactive_hint")}`;
  }
  return output;
}

/**
 * Декорация вывода завершённой команды: подсказки (пустой прогон скрипта,
 * упавшие тесты, npm-без-bin, Unix-команды в cmd.exe), audit-лог и обрезка.
 * Вынесена из god-handler'а bash — инкапсулирует всю пост-обработку вывода.
 */
export function decorateCommandOutput(opts: {
  ctx: ToolContext;
  command: string;
  originalCommand: string;
  code: number | null;
  output: string;
  testRun: TestRunSummary | null;
  workdir: string;
  securityConfig: BashSecurityConfig;
}): string {
  let output = opts.output;
  const { ctx, command, originalCommand, code, testRun, workdir, securityConfig } = opts;

  // R5: скрипт вышел в 0 молча — вероятно, нет точки входа
  // (main с argv никто не вызывает).
  const cliHint = emptyCliRunHint(command, output, code);
  if (cliHint) {
    output = `(exit code 0, no output)\n\nHint: ${cliHint}`;
  }

  // Автоверификация тест-ранов: упавший сьют нельзя отдавать как чистый
  // успех. Видный маркер, который модель не пропустит (типичный провал:
  // тесты падают при нулевом exit code CLI).
  if (testRun && testRun.failed > 0) {
    output =
      t("exec.test_runner_fail", {
        framework: testRun.framework,
        failed: String(testRun.failed),
        passed: String(testRun.passed),
      }) +
      `\n\n${output}`;
  } else if (testRun && testRun.failed === 0 && testRun.passed > 0) {
    output = `${t("exec.test_runner_pass", { framework: testRun.framework, passed: String(testRun.passed) })}\n\n${output}`;
  }

  if (!output && code !== 0) {
    output = `(exit code ${code})`;
  }

  // npm/npx/bunx: "could not determine executable to run" — у пакета нет
  // записи `bin` (или скрипта нет). Кроссплатформенно — до win32-блока хинтов.
  output = npmExecHint(output);

  // Интерактивный промпт без TTY (Bun/Node "Operation cancelled").
  output = interactivePromptHint(output);

  // На Windows — хинт про нерабочие Unix-команды и жёсткий стоп повторяющегося
  // падения. Хинт ключуют по ОРИГИНАЛЬНОМУ первому слову (до трансляции
  // adaptCommandForWindows cat→type): трансляция только для исполнения, а
  // модель писала `cat` — его и знает UNIX_TO_WIN_HINTS. Ключ по транслированному
  // слову делал `cat` невидимым для хинта/блока (наблюдено: cat 4+ раз).
  if (platform() === "win32") {
    const failing = failureCounters(ctx);
    const originalFirstWord = originalCommand.trim().split(/\s+/)[0]?.split(/[\\/]/).pop();
    if (originalFirstWord && originalFirstWord in UNIX_TO_WIN_HINTS) {
      if (code === 0) {
        failing.delete(originalFirstWord);
      } else {
        const failures = (failing.get(originalFirstWord) || 0) + 1;
        failing.set(originalFirstWord, failures);
        if (failures >= HARD_BLOCK_THRESHOLD) {
          output = `STOP using "${originalFirstWord}" — it does not work in this cmd.exe shell and has failed ${failures} times in a row. ${UNIX_TO_WIN_HINTS[originalFirstWord]}`;
        } else {
          output = `${output}\n\nHint: "${originalFirstWord}" may not work on Windows. ${UNIX_TO_WIN_HINTS[originalFirstWord]}`;
        }
      }
    }
  }

  // Запись результата в аудит-лог.
  if (securityConfig?.logCommands) {
    logBashCommand(
      ctx.sessionId,
      sanitizeCommandForLog(command),
      code === 0,
      `Working directory: ${workdir}, Output length: ${output.length}`,
    );
  }

  const lines = output.split("\n");
  if (testRun && testRun.failed > 0) {
    // Детали падения сохранить: раннеры печатают passing-маркеры первыми, а
    // ошибки + итог — в самом конце. Короткий head-превью прячет ровно то,
    // что нужно модели для починки.
    const TEST_TAIL_LINES = 400;
    const kept = lines.slice(-TEST_TAIL_LINES);
    const skipped = lines.length - kept.length;
    output =
      (skipped > 0 ? `[... ${skipped} earlier lines omitted — failing tests below]\n` : "") +
      kept.join("\n");
  } else if (lines.length > MAX_PREVIEW_LINES) {
    output =
      lines.slice(0, MAX_PREVIEW_LINES).join("\n") +
      `\n... (${lines.length - MAX_PREVIEW_LINES} more lines)`;
  }

  return output;
}
