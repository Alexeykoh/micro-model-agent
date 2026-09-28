/** Тул shell-команд: автофон, редирект tool-call, хинты Windows, мемо read-only. */
import type { ToolDefinition, ToolContext, } from "./types";
import { isCommandAllowed, sanitizeCommandForLog } from "../modules/security/command-validator";
import { logBashCommand, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { DEFAULT_SECURITY_CONFIG } from "../config/security";
import type { BashSecurityConfig } from "../config/types";
import { processRegistry, registerKillable, unregisterKillable } from "../modules/processes";
import { t } from "../i18n/index";
import { platform } from "os";
import { MAX_PREVIEW_LINES } from "./preview";
import {
  BASH_GRACE_MS as CANONICAL_BASH_GRACE_MS,
  /** Короткое окно для явного `background: true` — ловит ошибки спавна. */
  BASH_SPAWN_SETTLE_MS as SPAWN_SETTLE_MS,
} from "../config/timeouts";

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

/**
 * Подряд идущие падения по первому слову команды (сброс при успехе). Модель,
 * долбящую запрещённый Unix в cmd.exe (head/cat/grep/…), первые разы
 * подсказываем; после HARD_BLOCK_THRESHOLD подряд — жёсткий стоп с STOP
 * вместо вечного повтора хинта (наблюдено: `head` 5×, `Select-String` 3×).
 */
const FAILING_FIRST_WORDS = new Map<string, number>();
const HARD_BLOCK_THRESHOLD = 3;
// Module-level Map живёт весь процесс: при смене сессии (REPL /new, /resume)
// сбрасываем счётчики, чтобы старые падения не влияли на новую задачу.
let lastFailureSessionId: string | undefined;

/** Тестовый хук: сбросить счётчики подряд-падений. */
export function resetBashFailureTracking(): void {
  FAILING_FIRST_WORDS.clear();
}

/**
 * Детект записи файла через `echo/printf ... > file` — частая привычка модели,
 * ломающаяся в cmd.exe: одиночные кавычки не группируют, `>` относится только
 * к ПОСЛЕДНЕЙ строке многострочной команды, двойные кавычки внутри рвут
 * команду. Возвращает целевой файл или null.
 */
export function extractEchoFileWrite(command: string): string | null {
  if (!/^\s*(?:echo|printf)\b/i.test(command)) return null;
  const m = command.match(/[>»]{1,2}\s*"?([^"'\s&|]+)"?/i);
  if (!m) return null;
  return m[1].replace(/["'']$/g, "");
}

/**
 * В cmd.exe разделитель — `&`, а не `;` (bash). Модель регулярно чейнит через
 * `;` — без трансляции cmd отдаёт `;` первым аргументом команды (напр.
 * `node x.ts;` → ENOENT для "x.ts;"). `;` → `&` только ВНЕ двойных кавычек,
 * чтобы `echo "a;b"` уцелел (одиночные в cmd не спецсимвол).
 */
export function translateSemicolonsForCmd(command: string): string {
  let out = "";
  let inQuotes = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      out += ch;
      continue;
    }
    out += ch === ";" && !inQuotes ? "&" : ch;
  }
  return out;
}

function adaptCommandForWindows(command: string): string {
  if (platform() !== "win32") return command;

  // Модель иногда дописывает `|| true` (bash-идиома гашения ошибок), которой
  // PowerShell не знает. Замена на `; exit 0` — успешный код при любом исходе.
  if (/\|\|\s*true\b/.test(command)) {
    command = command.replace(/\s*\|\|\s*true\b/g, "; exit 0");
  }

  // Windows mkdir не знает -p/--parents, но промежуточные dirs создаёт по умолчанию.
  const trimmed = command.trim();
  if (/^mkdir\s+(-p|--parents)\b/.test(trimmed)) {
    return trimmed.replace(/^mkdir\s+(-p|--parents)\s*/, "mkdir ");
  }
  if (/^mkdir\s+(-p|--parents)\s*$/.test(trimmed)) {
    return "mkdir";
  }

  // Трансляция простых Unix-команд в эквиваленты cmd.exe. Переписывается только
  // ведущее слово; флаги сквозняком (ls -la → dir -la, cmd терпит). Формы с
  // пайпом не трогаем — сломаются.
  const firstWord = trimmed.split(/\s+/)[0]?.split(/[\\/]/).pop();
  const translated = firstWord ? UNIX_TO_WIN_TRANSLATE[firstWord] : undefined;
  if (
    translated &&
    !trimmed.includes("|") &&
    !trimmed.includes(">") &&
    !trimmed.includes("&&") &&
    !trimmed.includes(";")
  ) {
    return trimmed.replace(firstWord!, translated);
  }

  // Адаптации кодировок не надо — UTF-8/OEM-декод в registry.ts.
  return translateSemicolonsForCmd(command);
}

/** Типовой маппинг Unix → Windows для хинтов об ошибках. */
const UNIX_TO_WIN_HINTS: Record<string, string> = {
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

/** Unix-команды, прозрачно транслируемые в эквиваленты cmd.exe. */
const UNIX_TO_WIN_TRANSLATE: Record<string, string> = {
  ls: "dir",
  pwd: "cd",
  cat: "type",
};

/**
 * Детект перепутанного tool call в shell-команде — напр. `bash` с командой
 * "create_dir path=C:\...\src" или "read_file file=x". Это вызовы тулов, а не
 * команды; прогон через шелл падает. Возвращает имя тула и сырые аргументы
 * для редиректа в настоящий тул.
 */
/**
 * Shell-команды, которые НИКОГДА не считать перепутанными tool call. Модель
 * часто пишет файлы через `echo '<код со знаками =>` или читает через `cat` —
 * это команды шелла. Без гарда эвристика редиректа срабатывает на любое
 * `<слово> <текст с =>` и падает с "Unknown tool: echo".
 */
const NEVER_TOOL_CALLS = new Set([
  "echo",
  "cat",
  "type",
  "printf",
  "touch",
  "mkdir",
  "cp",
  "mv",
  "rm",
  "ls",
  "dir",
  "cd",
  "pwd",
  "grep",
  "find",
  "head",
  "tail",
  "wc",
  "chmod",
  "sed",
  "awk",
]);

/** Определяет перепутанный tool call в команде bash. Возврат: тул и сырые аргументы. */
export function detectToolCallInBash(command: string): {
  tool: string;
  args: string;
} | null {
  const match = command.trim().match(/^([\w-]+)\s+(.+)$/s);
  if (!match) return null;
  const tool = match[1];
  // Настоящие shell-команды (echo, cat, …) — никогда не перепутанные tool call.
  if (NEVER_TOOL_CALLS.has(tool)) return null;
  const rest = match[2].trim();
  // Tool call — только если первое слово похоже на snake_case-имя тула, а
  // остаток содержит хотя бы один '=' или JSON-форму.
  if (!/^[a-z][a-z0-9_]+$/.test(tool)) return null;
  if (!rest.includes("=") && !rest.startsWith("{")) return null;
  return { tool, args: rest };
}

/**
 * Парсит сырую строку аргументов перепутанного tool call в Record. Понимает
 * JSON-объекты ("{"path": "..."}") и пары key=value ("path=C:\...\src").
 * Значения — дословным текстом. Возврат: словарь аргументов.
 */
export function parseToolArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      /* fall through to key=value parsing */
    }
  }
  const args: Record<string, unknown> = {};
  // Токенизация с уважением к кавычкам в значениях.
  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      // Окаймляющие кавычки значений — снять.
      args[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return args;
}

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

/** Тулы управления процессами за enable_tools (тег "shell"). */
const HIDDEN_PROCESS_TOOLS = ["process_list", "process_log", "process_kill", "process_wait"];

/**
 * Read-only префиксы для мемоизации (см. `manualMemo` тула). Эвристика,
 * намеренно узкая: одиночные вызовы, немутирующие по построению. Всё составное
 * (`&`, `|`, `<`, `>`, `;`) — никогда в мемо. TTL 120с в исполнителе
 * ограничивает протухание от внешних правок.
 */
const READONLY_COMMAND_PREFIXES = [
  "git status",
  "git log",
  "git diff",
  "git branch",
  "git tag",
  "git rev-parse",
  "git ls-remote",
  "git remote",
  "git show",
  "npm view",
  "npm list",
  "npm config get",
  "npm whoami",
  "npm ping",
  "npm --version",
  "node --version",
  "python --version",
  "python3 --version",
  "bun --version",
  "git --version",
  "dir",
  "ls",
  "echo",
  "type",
  "where",
  "which",
  "cat",
];

const READONLY_COMMAND_PATTERNS = READONLY_COMMAND_PREFIXES.map(
  (p) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`),
);

/**
 * Мемоизируема ли (post-adaptation) команда: одиночный read-only вызов,
 * чей успешный результат можно кешировать. Экспортировано для тестов.
 */
export function isMemoizableCommand(command: string): boolean {
  const cmd = command.trim().toLowerCase();
  if (!cmd || /[|<>;&]/.test(cmd)) return false;
  return READONLY_COMMAND_PATTERNS.some((re) => re.test(cmd));
}

// Оборонительный доступ к мемо: самописные стабы ToolExecutor в тестах (и любой
// будущий минимальный исполнитель) могут не иметь memo-методов — считать промахом.
function memoRead(
  ctx: ToolContext,
  args: Record<string, unknown>,
): import("./types").ToolResult | undefined {
  const get = ctx.toolExecutor?.memoGet;
  return typeof get === "function" ? get.call(ctx.toolExecutor, "bash", args) : undefined;
}

function memoWrite(
  ctx: ToolContext,
  args: Record<string, unknown>,
  result: import("./types").ToolResult,
): void {
  const set = ctx.toolExecutor?.memoSet;
  if (typeof set === "function") set.call(ctx.toolExecutor, "bash", args, result);
}

function memoClear(ctx: ToolContext): void {
  const clear = ctx.toolExecutor?.memoInvalidate;
  if (typeof clear === "function") clear.call(ctx.toolExecutor);
}

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

/**
 * Декорация вывода завершённой команды: подсказки (пустой прогон скрипта,
 * упавшие тесты, npm-без-bin, Unix-команды в cmd.exe), audit-лог и обрезка.
 * Вынесена из god-handler'а bash — инкапсулирует всю пост-обработку вывода.
 */
function decorateCommandOutput(opts: {
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
    if (ctx.sessionId !== lastFailureSessionId) {
      lastFailureSessionId = ctx.sessionId;
      FAILING_FIRST_WORDS.clear();
    }
    const originalFirstWord = originalCommand.trim().split(/\s+/)[0]?.split(/[\\/]/).pop();
    if (originalFirstWord && originalFirstWord in UNIX_TO_WIN_HINTS) {
      if (code === 0) {
        FAILING_FIRST_WORDS.delete(originalFirstWord);
      } else {
        const failures = (FAILING_FIRST_WORDS.get(originalFirstWord) || 0) + 1;
        FAILING_FIRST_WORDS.set(originalFirstWord, failures);
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

export const bashTool: ToolDefinition = {
  name: "bash",
  icon: "💻",
  description:
    "Execute a shell command and return its output. Use for running tests, build, git, and shell operations. Commands that are still running after a few seconds are automatically moved to the background and return a process id — manage them with process_list, process_log, process_wait, process_kill. For a finite background task prefer a single process_wait over polling process_log or sleeping (never use ping/timeout/sleep as a delay). Set background=true to return a process id immediately for commands you know are long-running (dev servers, watchers).\n\nWindows notes: the shell is cmd.exe — PowerShell cmdlets (Write-Host, Get-Content, Select-String, Out-File) and bash heredocs (cat << EOF) do NOT work there. Use the read_file/write_file tools instead of cat/echo redirection. Sequential commands: use && (a leading ; is auto-converted to &).",
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

    // Discovery скрытых тулов: при сужении набора process_* невидимы модели,
    // и прогон их через cmd.exe даёт лишь "is not recognized" (в одной сессии —
    // три впустую). Указать на enable_tools (k=v-формы ушли редиректом выше).
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

    // echo/printf-редирект в файл ненадёжен в cmd.exe (одиночные кавычки не
    // группируют, многострочник рвётся, вложенные двойные кавычки ломают
    // команду). Вести на write_file — с ним файлы корректны всегда.
    if (platform() === "win32") {
      const echoWrite = extractEchoFileWrite(originalCommand);
      if (echoWrite) {
        return {
          success: false,
          output: t("bash.echo_write_blocked", { path: echoWrite }),
        };
      }
    }
    const workdir = args.workdir ? String(args.workdir) : ctx.baseDir;

    // Session-specific security config (мастер-выключатель учтён внутри).
    const securityConfig = resolveBashSecurityConfig(ctx);
    const validation = isCommandAllowed(command, securityConfig);

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

    const entry = processRegistry.start(command, workdir, ctx.sessionId);
    if (ctx.activeCallId) {
      // Исполнителю — убить дочерний процесс в grace-окне при аборте.
      registerKillable(ctx.activeCallId, () => processRegistry.kill(entry.id));
    }

    try {
      const settleMs = args.background === true ? SPAWN_SETTLE_MS : bashGraceMs;
      const exited = await processRegistry.waitForExit(entry.id, settleMs);

      if (exited) {
        // Команда уложилась в окно (включая ошибку спавна).
        if (entry.spawnError) {
          return {
            success: false,
            output: `[process error] ${entry.spawnError}\nHint: check the "workdir" path exists and the command is valid for this OS.`,
          };
        }

        const code = entry.exitCode;
        let output = entry.log.join("\n");
        processRegistry.remove(entry.id);

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

      // Всё ещё жива — в фоновые процессы.
      const explicit = args.background === true;
      const preview = entry.log
        .filter((l) => l.trim() !== "")
        .slice(0, BG_OUTPUT_PREVIEW_LINES)
        .join("\n");
      let output = `${t("proc.started", {
        id: entry.id,
        pid: entry.pid,
        command,
      })}${explicit ? "" : `\n${t("proc.promoted_hint", { ms: settleMs })}`}`;
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
        unregisterKillable(ctx.activeCallId);
      }
    }
  },
};
