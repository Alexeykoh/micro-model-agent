// Детектор застревания: повторы, фейлы, bash-флейлинг, хинты.
import { canonicalArgsKey } from "../../core/api";
import { t } from "../../i18n/index";
import { isTransientError } from "./transient-error";

interface ToolCallRecord {
  name: string;
  argsKey: string;
}

/** Классификация ошибки: транзиентная, системная, блокирующая. */
export type ErrorClassification = "transient" | "systematic" | "blocking";

/**
 * Стабильная машиночитаемая таксономия фейлов для stuck/recovery-диагностики.
 *
 * Маппится из живых состояний детектора (см. `classifyFailure`). Изначальный
 * план называл ещё `scope_drift` и `empty_output`; ни у того, ни у другого нет
 * надёжного сигнала детектора здесь (scope drift не трекается, пустой вывод
 * покрыт `getActionableHints`), поэтому не выдумываем.
 */
export type FailureType =
  | "timeout" // no progress across N iterations on the current step
  | "repeat" // identical tool call (same args) repeated
  | "error_loop" // one tool, or consecutive calls, failing repeatedly
  | "bash_flailing"; // rotating failing shell commands

/** Классификация фейла: тип, тул, счётчик, итерация (0 — неизвестна). */
export interface FailureClassification {
  type: FailureType;
  /** Тул, к которому относится фейл, если известен. */
  tool?: string;
  /** Счётчик повторов/фейлов, если значим. */
  count?: number;
  /** Итерация цикла агента на момент классификации (0 — неизвестна). */
  iteration: number;
}

const BLOCKING_PATTERNS = [
  /EACCES/i,
  /permission denied/i,
  /EPERM/i,
  /ENOENT.*node_modules/i,
  /ENOTDIR/i,
  /invalid.*token/i,
  /unauthorized/i,
  /401/i,
  /403/i,
];

/** Классифицирует вывод ошибки: транзиентная / блокирующая / системная. */
export function classifyError(output: string): ErrorClassification {
  if (isTransientError(output)) return "transient";
  for (const p of BLOCKING_PATTERNS) {
    if (p.test(output)) return "blocking";
  }
  return "systematic";
}

/**
 * Bash-флейлинг: ≥BASH_FLAIL_THRESHOLD фейлов в последних BASH_FLAIL_WINDOW
 * bash-попытках, независимо от перемежающихся успехов. Per-word hard-stop
 * (bash.ts) обходится ротацией команд (wc → cat → Get-Content → …); окно
 * ловит саму ротацию (было в ses_mt4x3zbo: 8 фейловых shell-уловок за ~12
 * итераций при подсчёте/склейке файлов на Windows).
 */
const BASH_FLAIL_WINDOW = 6;
const BASH_FLAIL_THRESHOLD = 4;
/** Окно исходов (ok/fail) для оценки «пошли фейлы» (§1.3 аудита). */
const RECENT_OUTCOMES_WINDOW = 6;

const ANSI_RE = /\x1b\[[0-9;]*m/g;
/** Пути (абсолютные/относительные) + опционально :line:col. */
const ERROR_LOC_RE =
  /(?:[A-Za-z]:[\\/])?(?:[\w.@+-]+[\\/])+[\w.@+-]+\.[a-zA-Z0-9]{1,6}(?::\d+(?::\d+)?)?/g;
const SIGNATURE_MAX_CHARS = 120;

const SEARCHABLE_PATTERNS: RegExp[] = [
  /error TS\d+/i,
  /ERR_[A-Z_]+/,
  /ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EADDRINUSE/i,
  /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/i,
  /TypeError|ReferenceError|SyntaxError|RangeError/i,
  /is not a function|is not defined|is not a constructor/i,
  /Cannot read properties of/i,
  /failed to (compile|build|resolve|parse)/i,
  /fatal error|panic/i,
];

const RUNTIME_WORDS = [
  "bun",
  "node",
  "deno",
  "npm",
  "yarn",
  "pnpm",
  "pip",
  "pip3",
  "python",
  "python3",
  "tsc",
  "tsx",
  "npx",
  "go",
  "cargo",
  "gradle",
  "maven",
  "make",
];
const FRAMEWORK_WORDS = [
  "react",
  "vue",
  "angular",
  "svelte",
  "vite",
  "next",
  "nest",
  "express",
  "fastify",
  "flask",
  "django",
  "spring",
  "webpack",
  "tailwind",
];

/**
 * Стабильная идентичность ошибки: тул + нормализованные первые error-строки
 * (ANSI вычищен, пути/локации заменены, пробелы склеены, кап 120 символов).
 * Два прогона с одной первопричиной дают одну сигнатуру — она и триггерит
 * автопоиск в вебе.
 */
export function normalizeErrorSignature(toolName: string, output?: string): string | null {
  if (!output) return null;
  const cleaned = output
    .replace(ANSI_RE, "")
    .replace(ERROR_LOC_RE, " <path>")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return `${toolName}::${cleaned.slice(0, SIGNATURE_MAX_CHARS)}`;
}

/**
 * Гейт автопоиска в вебе: искать стоит только реальный содержательный текст
 * ошибки. "Command failed with exit code 1" без деталей — шум, поиск по нему
 * лишь жжёт запрос.
 */
export function isSearchableError(output: string): boolean {
  if (!output?.trim()) return false;
  const text = output.trim();
  return SEARCHABLE_PATTERNS.some((p) => p.test(text));
}

/**
 * Строит поисковый запрос по падающей ошибке: до 3 чищенных error-строк (пути
 * вырезаны) с префиксом рантайма/фреймворка из step/bash-контекста и суффиксом
 * "how to fix". На пустом тексте — фолбэк `tool step`. Кап maxQueryChars.
 */
export function buildSearchQuery(
  stepDescription: string,
  lastBashCommand: string,
  lastErrorOutput: string,
  toolName: string,
  maxQueryChars: number,
): string {
  const errorText = (lastErrorOutput || "")
    .replace(ANSI_RE, "")
    .replace(ERROR_LOC_RE, " <path>")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const context = `${stepDescription} ${lastBashCommand}`.toLowerCase();
  const runtime = RUNTIME_WORDS.find((w) => context.includes(w)) || "";
  const framework = FRAMEWORK_WORDS.find((w) => context.includes(w)) || "";
  let query: string;
  if (errorText) {
    query =
      runtime && !errorText.toLowerCase().includes(runtime) ? `${runtime} ${errorText}` : errorText;
    if (framework && !query.toLowerCase().includes(framework)) query = `${query} ${framework}`;
    query = `${query} how to fix`;
  } else if (runtime || framework) {
    query = `${[runtime, framework, "error", "how to fix"].filter(Boolean).join(" ")}`;
  } else {
    query = `${toolName} ${stepDescription} how to fix`;
  }
  return query.slice(0, maxQueryChars);
}

/** Детектор застревания: счётчики итераций, ошибок, повторов, петель, эскалаций. */
export class StuckDetector {
  private threshold: number;
  private errorThreshold: number;
  private iterationsOnCurrentStep = 0;
  private currentStepId: number | null = null;
  private toolErrors: Map<string, number> = new Map();
  private currentStepDescription = "";
  private recentToolCalls: ToolCallRecord[] = [];
  private readonly maxRecentCalls = 10;
  private readonly repetitionThreshold = 3;
  private consecutiveFailures = 0;
  /**
   * Окно исходов последних вызовов (`ok`/`fail`). Единственный источник правды
   * для «пошли фейлы»: успех чужого тула не отменяет накопленные ошибки
   * (§1.3 аудита) — иначе паттерн `bash✗, read✓, bash✗` вечно молчит.
   */
  private recentOutcomes: ("ok" | "fail")[] = [];
  private lastFailedTool = "";
  private lastErrorOutput = "";
  private escalationCount = 0;
  private readonly escalationThreshold = 3;
  private fileRewriteCount: Map<string, number> = new Map();
  private readonly fileRewriteThreshold = 3;
  private lastBashCommand = "";
  private lastBashOutput = "";
  private emptyBashRunCount = 0;
  private bashRecent: boolean[] = [];
  private errorSignatureCounts: Map<string, number> = new Map();
  private searchedErrorSignatures: Set<string> = new Set();
  private webSearchThreshold: number;

  constructor(threshold = 6, errorThreshold = 3, webSearchThreshold = 5) {
    this.threshold = threshold;
    this.errorThreshold = errorThreshold;
    this.webSearchThreshold = webSearchThreshold;
  }

  recordIteration(stepId: number): void {
    if (stepId === this.currentStepId) {
      this.iterationsOnCurrentStep++;
    } else {
      this.resetStepState(stepId);
    }
  }

  /** Отмечает вызов тула (для детекции повторов). */
  recordToolCall(name: string, args: Record<string, unknown>): void {
    const argsKey = canonicalArgsKey(name, args);
    this.recentToolCalls.push({ name, argsKey });
    if (this.recentToolCalls.length > this.maxRecentCalls) {
      this.recentToolCalls.shift();
    }
  }

  /** Отмечает ошибку тула (счётчики + сигнатура для автопоиска). */
  recordToolError(toolName: string, output?: string): void {
    this.toolErrors.set(toolName, (this.toolErrors.get(toolName) || 0) + 1);
    this.consecutiveFailures++;
    this.pushOutcome("fail");
    this.lastFailedTool = toolName;
    if (output) this.lastErrorOutput = output;
    const sig = normalizeErrorSignature(toolName, output);
    if (sig) {
      this.errorSignatureCounts.set(sig, (this.errorSignatureCounts.get(sig) || 0) + 1);
    }
  }

  /** Последний текст ошибки. */
  getLastErrorOutput(): string {
    return this.lastErrorOutput;
  }

  /**
   * Записывает КАЖДЫЙ вызов bash (успех или нет): детекция рассуждает о
   * повторных прогонах с пустым выводом, проблемах entry-point и ошибках
   * платформы (PowerShell-командлеты в cmd.exe, bash-heredoc'и, …).
   */
  recordBashOutput(command: string, output: string): void {
    const trimmed = output.trim();
    if (command === this.lastBashCommand && !trimmed) {
      this.emptyBashRunCount++;
    } else {
      this.emptyBashRunCount = 0;
    }
    this.lastBashCommand = command;
    this.lastBashOutput = output;
  }

  /** Исход одной bash-попытки (успех/фейл) — для детекции флейлинга. */
  recordBashAttempt(success: boolean): void {
    this.bashRecent.push(success);
    if (this.bashRecent.length > BASH_FLAIL_WINDOW) this.bashRecent.shift();
  }

  /** True, если свежие bash-попытки в массе фейлятся — модель флейлит. */
  hasBashFlailing(): boolean {
    if (this.bashRecent.length < BASH_FLAIL_THRESHOLD) return false;
    let failures = 0;
    for (const ok of this.bashRecent) if (!ok) failures++;
    return failures >= BASH_FLAIL_THRESHOLD;
  }

  /** Последняя bash-команда. */
  getLastBashCommand(): string {
    return this.lastBashCommand;
  }

  /** Вывод последней bash-команды. */
  getLastBashOutput(): string {
    return this.lastBashOutput;
  }

  /** Последний упавший тул. */
  getLastFailedTool(): string {
    return this.lastFailedTool;
  }

  /**
   * Первая сигнатура ошибки, чей счётчик повторов достиг порога веб-поиска и
   * которая ЕЩЁ не искалась (или размаркирована для ретрая). Именно она
   * триггерит автопоиск — не итерации и не per-tool счётчик ошибок.
   */
  getRepeatedErrorSignature(): string | null {
    for (const [sig, count] of this.errorSignatureCounts) {
      if (count >= this.webSearchThreshold && !this.searchedErrorSignatures.has(sig)) {
        return sig;
      }
    }
    return null;
  }

  /** Счётчик повторов сигнатуры ошибки. */
  getErrorSignatureCount(sig: string): number {
    return this.errorSignatureCounts.get(sig) || 0;
  }

  /** Помечает сигнатуру как уже искавшуюся. */
  markErrorSearched(sig: string): void {
    this.searchedErrorSignatures.add(sig);
  }

  /** Снимает метку поиска (разрешает один ретрай). */
  unmarkErrorSearched(sig: string): void {
    this.searchedErrorSignatures.delete(sig);
  }

  /** True, если сигнатура уже искалась. */
  hasErrorSearched(sig: string): boolean {
    return this.searchedErrorSignatures.has(sig);
  }

  /** Итераций на текущем шаге. */
  getIterationsOnCurrentStep(): number {
    return this.iterationsOnCurrentStep;
  }

  /** Отмечает успешный тул: сброс фейлов, затухание per-tool счётчиков и итераций. */
  recordToolSuccess(toolName?: string): void {
    this.pushOutcome("ok");
    // NOTE: escalationCount осознанно НЕ сбрасываем. Один тривиальный успех
    // (напр. один read_file) раньше его чистил, и shouldEscalate() на флейлящей
    // сессии почти не достигался — в ущерб анти-гейминг свойству, которое
    // resetStepState() явно хранит.
    // Затухание per-tool счётчиков на продуктивных вызовах: рано упавший тул не
    // держит варнинг "Tool X failed N times" вечно (ses_mt4fn58c — bash упал 3x,
    // варнинг перелоггировался после 30 успешных записей). Свежие фейлы счёт
    // набирают заново.
    // Затухание per-tool счётчиков: снимается одна запись ТОЛЬКО того тула,
    // который отработал. Раньше успех любого тула гасил счётчик падавшего —
    // паттерн `bash✗, read✓, bash✗` не достигал порога (§1.3 аудита).
    if (toolName) {
      const count = this.toolErrors.get(toolName);
      if (count !== undefined) {
        if (count <= 1) this.toolErrors.delete(toolName);
        else this.toolErrors.set(toolName, count - 1);
      }
    }
    // Затухание счётчика итераций на продуктивных вызовах: чтение новых файлов,
    // записи, правки — всё прогресс. Защита от ложных stuck-варнингов при
    // легитимной разведке файлов (напр. чтение 12 файлов в analytic-шаге).
    if (this.iterationsOnCurrentStep > 0) {
      this.iterationsOnCurrentStep = Math.max(0, this.iterationsOnCurrentStep - 1);
    }
  }

  /** Кладёт исход в окно и обрезает его по длине. */
  private pushOutcome(outcome: "ok" | "fail"): void {
    this.recentOutcomes.push(outcome);
    if (this.recentOutcomes.length > RECENT_OUTCOMES_WINDOW) this.recentOutcomes.shift();
  }

  /** Фейлы в окне последних вызовов (окно, а не счётчик с обнулением). */
  private failuresInWindow(): number {
    let failures = 0;
    for (const outcome of this.recentOutcomes) if (outcome === "fail") failures++;
    return failures;
  }

  /** Ставит текущий шаг (сброс per-step состояния при смене). */
  setCurrentStep(stepId: number, description: string): void {
    if (stepId !== this.currentStepId) {
      this.resetStepState(stepId);
    }
    this.currentStepDescription = description;
  }

  /** True, если итераций на шаге больше порога. */
  isStuck(): boolean {
    return this.iterationsOnCurrentStep > this.threshold;
  }

  /** Счётчик ошибок конкретного тула (0 — ошибок не было). */
  getToolErrorCount(toolName: string): number {
    return this.toolErrors.get(toolName) ?? 0;
  }

  /** True, если тул (или любой) ошибался ≥ порога. */
  hasRepetitiveErrors(toolName?: string): boolean {
    if (toolName) {
      return (this.toolErrors.get(toolName) || 0) >= this.errorThreshold;
    }
    return Array.from(this.toolErrors.values()).some((c) => c >= this.errorThreshold);
  }

  /** True при повторяющихся вызовах: подряд идентичных или перемежающихся (A,B,A,B,A). */
  hasRepetitiveToolCalls(): boolean {
    if (this.recentToolCalls.length < this.repetitionThreshold) return false;
    const last = this.recentToolCalls[this.recentToolCalls.length - 1];
    // Проверка подряд идентичных (исходная логика)
    let consecutiveCount = 1;
    for (let i = this.recentToolCalls.length - 2; i >= 0; i--) {
      // argsKey = `name::canonicalArgs` — имя уже внутри, сравниваем ключ.
      if (this.recentToolCalls[i].argsKey === last.argsKey) {
        consecutiveCount++;
      } else {
        break;
      }
    }
    if (consecutiveCount >= this.repetitionThreshold) return true;
    // Плюс перемежающиеся паттерны (A, B, A, B, A): считаем каждую связку
    // тул+args в окне и флагуем при ≥ порога
    const counts = new Map<string, number>();
    for (const call of this.recentToolCalls) {
      counts.set(call.argsKey, (counts.get(call.argsKey) || 0) + 1);
    }
    for (const count of counts.values()) {
      if (count >= this.repetitionThreshold) return true;
    }
    return false;
  }

  /** True при ≥ порога подряд фейлов. */
  /** True, если в окне последних вызовов хватает фейлов (окно, а не streak). */
  hasConsecutiveFailures(): boolean {
    return this.failuresInWindow() >= this.errorThreshold;
  }

  /** Число фейлов в окне последних вызовов. */
  getConsecutiveFailuresCount(): number {
    return this.failuresInWindow();
  }

  /** Отмечает эскалацию (счётчик для shouldEscalate). */
  recordEscalation(): void {
    this.escalationCount++;
  }

  /** True, если эскалаций набралось на порог. */
  shouldEscalate(): boolean {
    return this.escalationCount >= this.escalationThreshold;
  }

  /** Сбрасывает счётчик эскалаций. */
  resetEscalation(): void {
    this.escalationCount = 0;
  }

  /** Число эскалаций. */
  getEscalationCount(): number {
    return this.escalationCount;
  }

  /** Хинты по описанию шага + состояниям, ещё не покрытым recovery-сообщением. */
  getHints(): string[] {
    const hints: string[] = [];
    const desc = this.currentStepDescription.toLowerCase();

    if (desc.includes("install") || desc.includes("npm") || desc.includes("pip")) {
      hints.push(t("exec.hint_deps"));
    }
    if (desc.includes("test") || desc.includes("spec")) {
      hints.push(t("exec.hint_test"));
    }
    if (desc.includes("build") || desc.includes("compile")) {
      hints.push(t("exec.hint_build"));
    }
    if (desc.includes("deploy") || desc.includes("publish")) {
      hints.push(t("exec.hint_deploy"));
    }

    // State-based буллеты. Recovery-сообщение (getRecoveryMessage) уже репортит
    // ПЕРВИЧНУЮ причину (приоритет: stuck > tool-errors > bash-flailing >
    // consecutive > repetitive). Дублировать то же состояние хинтом — задвоить
    // гайданс в одном cooldown-блоке. Буллет добавляем, только если recovery
    // это состояние НЕ покрывает.
    const primary = this.getPrimaryReason();
    if (this.hasRepetitiveToolCalls() && primary !== "repetitive") {
      hints.push(t("exec.hint_repetitive"));
    }
    if (this.hasConsecutiveFailures() && primary !== "consecutive") {
      hints.push(t("exec.hint_consecutive"));
    }
    return hints;
  }

  /** Actionable-хинты по последней ошибке: рантаймы, синтаксис, сеть, шелл-несоответствия. */
  getActionableHints(): string[] {
    const hints: string[] = [];
    const error = this.lastErrorOutput;

    // Bash-хинты от фейла тула не зависят — срабатывают, даже когда команда
    // "успешна" с пустым выводом (потерянный entry point).
    const isScriptRun =
      /(^|[\s&])(bun|node|tsx|ts-node|deno|python|python3)\S*\s+[^|&]+\s+[^\s]+$/.test(
        this.lastBashCommand,
      );
    if (isScriptRun && !this.lastBashOutput.trim() && this.emptyBashRunCount >= 2) {
      hints.push(
        `The command "${this.lastBashCommand}" ran ${this.emptyBashRunCount} times with EMPTY output. The program likely has no entry point — read the file with read_file and check that it actually calls its main function with process.argv / CLI arguments and prints results (console.log). Then run it again.`,
      );
    }

    if (!error) return hints;

    // Несовместимость рантайма — тул/модуль крашится на этой версии Node
    if (/Cannot read properties of undefined|is not a function|is not a constructor/i.test(error)) {
      if (/node_modules/.test(error)) {
        hints.push(
          "A dependency is incompatible with your Node.js version. Check if there is an alternative package or use a different runtime.",
        );
      }
    }

    // Синтаксические ошибки TypeScript — модель сгенерила невалидный код
    if (/TS1005|TS1003|TS1109|TS1128|TS1434/i.test(error)) {
      hints.push(
        "TypeScript syntax error. Read the error message carefully — it tells you the exact line and column. Fix the syntax before retrying.",
      );
    }

    // Ошибки типов TypeScript — модель не понимает типы
    if (/TS2322|TS2345|TS2769|TS7006|TS7016/i.test(error)) {
      hints.push(
        "TypeScript type mismatch. Check the type signature of the function/API you are using. If a package lacks type declarations, install @types/<package> or use skipLibCheck.",
      );
    }

    // Модуль не найден — нет зависимости или неверный импорт
    if (/Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/i.test(error)) {
      hints.push("Module not found. Run npm install or check if the import path is correct.");
    }

    // Ошибки прав доступа
    if (/EACCES|EPERM|permission denied/i.test(error)) {
      hints.push("Permission denied. Check file permissions or run with appropriate privileges.");
    }

    // Сетевые ошибки
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(error)) {
      hints.push("Network error. Check if the server is running and accessible.");
    }

    // Команда не найдена
    if (/is not recognized|command not found|not found in path/i.test(error)) {
      hints.push("Command not found. Check if the tool is installed and in PATH.");
    }

    // Петля перезаписи: один файл безуспешно переписывается
    if (this.hasExcessiveRewrites()) {
      const file = this.getExcessiveRewriteFile();
      hints.push(
        `File ${file} has been rewritten ${this.getFileRewriteCount(file!)} times without success. Stop rewriting and try a fundamentally different approach.`,
      );
    }

    // Повторные идентичные bash-прогоны с пустым выводом — вероятно, потерянный
    // entry point (программа не вызывает main).

    // PowerShell-командлеты внутри cmd.exe (шелл-несоответствие Windows).
    if (/Write-Host|Get-Content|Select-String|Out-File|Set-Content/i.test(error)) {
      hints.push(
        "That looks like a PowerShell cmdlet — the shell here is cmd.exe. Use echo/type for output or the read_file/write_file tools instead.",
      );
    }

    // Модель выдумала несуществующий Bun API.
    if (
      /Bun\.\w+ is not a function|Bun\.\w+ is not defined|Bun\.\w+ is not a constructor/i.test(
        error,
      )
    ) {
      hints.push(
        "That Bun API does not exist. Verify the API name in the Bun docs — common ones are Bun.file, Bun.write, Bun.spawn, Bun.serve. For file checks use fs.existsSync from node:fs.",
      );
    }

    // Модель продолжает писать файл, в выводе которого type/syntax ошибка —
    // читай реальную ошибку и чини её, не переписывай вслепую.
    if (/error TS\d+|typecheck failed|syntax check failed/i.test(error)) {
      hints.push(
        "The file still has a type/syntax error (see the error line in the output). Read the file with read_file around the reported line, fix the actual error, then re-run — rewriting the whole file blindly usually makes it worse.",
      );
    }

    // Bash-heredoc в cmd.exe.
    if (/unexpected.*<<|Непредвиденное появление/i.test(error)) {
      hints.push(
        "Heredoc (<< EOF) is a bash feature — this shell is cmd.exe and does not support it. Write the file with write_file instead.",
      );
    }

    return hints;
  }

  /** Альтернативный тул при рантайм-краше (ts-node→tsx, jest→vitest, …). Null, если нечего предложить. */
  getToolAlternative(): string | null {
    const tool = this.lastFailedTool;
    const error = this.lastErrorOutput;

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

  /** Отмечает перезапись файла (счётчик для детекции петли). */
  recordFileRewrite(filePath: string): void {
    const count = (this.fileRewriteCount.get(filePath) || 0) + 1;
    this.fileRewriteCount.set(filePath, count);
  }

  /** Число перезаписей файла. */
  getFileRewriteCount(filePath: string): number {
    return this.fileRewriteCount.get(filePath) || 0;
  }

  /** True, если какой-то файл переписывается ≥ порога. */
  hasExcessiveRewrites(): boolean {
    return Array.from(this.fileRewriteCount.values()).some((c) => c >= this.fileRewriteThreshold);
  }

  /** Файл с избыточными перезаписями, или null. */
  getExcessiveRewriteFile(): string | null {
    for (const [file, count] of this.fileRewriteCount) {
      if (count >= this.fileRewriteThreshold) return file;
    }
    return null;
  }

  /** Сообщение о повторяющемся туле (+хинт про process_wait для process_log). */
  getRepetitiveToolMessage(): string {
    if (!this.hasRepetitiveToolCalls()) return "";
    const last = this.recentToolCalls[this.recentToolCalls.length - 1];
    const base = t("exec.repetitive_tool", {
      tool: last.name,
      count: this.repetitionThreshold,
    });
    // Опрос фонового процесса по одному process_log за раз жжёт LLM-вызов на
    // опрос — указываем на одиночное блокирующее ожидание.
    if (last.name === "process_log") {
      return `${base} ${t("exec.repetitive_process_log_hint")}`;
    }
    return base;
  }

  /**
   * Стабильная идентичность варнинга для анти-спам дедупа: тот же ключ каждую
   * итерацию — спам, НОВЫЙ ключ (или длинная пауза) заслуживает re-warn.
   */
  getWarningKey(): string {
    if (this.isStuck()) return "stuck";
    const errorTool = Array.from(this.toolErrors.entries()).find(
      ([_, c]) => c >= this.errorThreshold,
    );
    if (errorTool) return `tool-errors:${errorTool[0]}`;
    if (this.hasBashFlailing()) return "bash-flailing";
    if (this.hasConsecutiveFailures()) return "consecutive";
    if (this.hasRepetitiveToolCalls()) return "repetitive";
    return "";
  }

  /** Причина застревания для лога (пусто если здоров). */
  getStuckReason(): string {
    if (this.isStuck()) {
      return t("exec.stuck", {
        stepId: String(this.currentStepId ?? "?"),
        description: this.currentStepDescription,
        iterations: this.iterationsOnCurrentStep,
      });
    }
    const errorTool = Array.from(this.toolErrors.entries()).find(
      ([_, c]) => c >= this.errorThreshold,
    );
    if (errorTool) {
      return t("exec.tool_errors", { tool: errorTool[0], count: errorTool[1] });
    }
    if (this.hasBashFlailing()) {
      const fails = this.bashRecent.filter((ok) => !ok).length;
      return t("exec.bash_flailing", {
        fails: String(fails),
        window: String(this.bashRecent.length),
      });
    }
    if (this.hasConsecutiveFailures()) {
      return t("exec.consecutive_failures", { count: String(this.consecutiveFailures) });
    }
    // Повторные идентичные вызовы — петля, даже если ничего не фейлится (напр.
    // цикл опроса process_log): без этой ветки оставались невидимы —
    // getWarningKey репортил "repetitive", но причина не логгировалась.
    if (this.hasRepetitiveToolCalls()) {
      return this.getRepetitiveToolMessage();
    }
    return "";
  }

  /** Recovery-сообщение по первичной причине (пусто если здоров). */
  getRecoveryMessage(): string {
    const reason = this.getPrimaryReason();
    if (reason === "stuck") {
      return t("exec.stuck_recovery", {
        iterations: this.iterationsOnCurrentStep,
        stepId: String(this.currentStepId ?? "?"),
        description: this.currentStepDescription,
      });
    }
    // Per-tool recovery (конкретнее — напр. "bash упал 3 раза")
    if (reason === "tool-errors") {
      const errorTool = Array.from(this.toolErrors.entries()).find(
        ([_, c]) => c >= this.errorThreshold,
      )!;
      return t("exec.tool_errors_recovery", {
        tool: errorTool[0],
        count: errorTool[1],
      });
    }
    // Подряд фейлы разных тулов (общее — напр. "5 consecutive failures")
    if (reason === "consecutive") {
      return t("exec.consecutive_failures_recovery", {
        count: this.consecutiveFailures,
      });
    }
    if (reason === "bash-flailing") {
      const fails = this.bashRecent.filter((ok) => !ok).length;
      return t("exec.bash_flailing_recovery", {
        fails: String(fails),
        window: String(this.bashRecent.length),
      });
    }
    if (reason === "repetitive") {
      return this.getRepetitiveToolMessage();
    }
    return "";
  }

  /**
   * Классифицирует текущее состояние фейла в стабильный {@link FailureType}
   * для диагностики/логов. Null если здоров. `iteration` даёт вызывающий
   * (детектор глобальный счётчик цикла не ведёт).
   */
  classifyFailure(iteration = 0): FailureClassification | null {
    const primary = this.getPrimaryReason();
    if (!primary) return null;
    switch (primary) {
      case "stuck":
        return { type: "timeout", iteration };
      case "tool-errors": {
        const entry = Array.from(this.toolErrors.entries()).find(
          ([, c]) => c >= this.errorThreshold,
        );
        return { type: "error_loop", tool: entry?.[0], count: entry?.[1], iteration };
      }
      case "consecutive":
        return { type: "error_loop", count: this.consecutiveFailures, iteration };
      case "repetitive": {
        const last = this.recentToolCalls[this.recentToolCalls.length - 1];
        return { type: "repeat", tool: last?.name, count: this.repetitionThreshold, iteration };
      }
      case "bash-flailing": {
        const fails = this.bashRecent.filter((ok) => !ok).length;
        return { type: "bash_flailing", count: fails, iteration };
      }
    }
  }

  /** Компактный маркер `[STUCK: type=..., tool=..., count=..., iteration=N]`. */
  formatFailureDiagnostic(c: FailureClassification): string {
    const parts = [`type=${c.type}`];
    if (c.tool) parts.push(`tool=${c.tool}`);
    if (typeof c.count === "number") parts.push(`count=${c.count}`);
    if (c.iteration > 0) parts.push(`iteration=${c.iteration}`);
    return `[STUCK: ${parts.join(", ")}]`;
  }

  /** Диагностический маркер текущего состояния, или "" если здоров. */
  getStuckDiagnostic(iteration = 0): string {
    const c = this.classifyFailure(iteration);
    return c ? this.formatFailureDiagnostic(c) : "";
  }

  /**
   * Единый источник правды приоритета recovery-причины. Общий для
   * getRecoveryMessage() и getHints(), чтобы не расходились: bullet состояния,
   * которое getRecoveryMessage уже репортит, хинтом НЕ дублируется
   * (приоритет: stuck > tool-errors > bash-flailing > consecutive > repetitive).
   */
  private getPrimaryReason():
    | "stuck"
    | "tool-errors"
    | "consecutive"
    | "repetitive"
    | "bash-flailing"
    | null {
    if (this.isStuck()) return "stuck";
    const errorTool = Array.from(this.toolErrors.entries()).find(
      ([_, c]) => c >= this.errorThreshold,
    );
    if (errorTool) return "tool-errors";
    if (this.hasBashFlailing()) return "bash-flailing";
    if (this.hasConsecutiveFailures()) return "consecutive";
    if (this.hasRepetitiveToolCalls()) return "repetitive";
    return null;
  }

  /** Полный сброс всего состояния детектора. */
  reset(): void {
    this.currentStepId = null;
    this.iterationsOnCurrentStep = 0;
    this.toolErrors.clear();
    this.consecutiveFailures = 0;
    this.recentOutcomes = [];
    this.lastFailedTool = "";
    this.lastErrorOutput = "";
    this.recentToolCalls = [];
    this.fileRewriteCount.clear();
    this.escalationCount = 0;
    this.lastBashCommand = "";
    this.lastBashOutput = "";
    this.emptyBashRunCount = 0;
    this.bashRecent = [];
    this.errorSignatureCounts.clear();
    this.searchedErrorSignatures.clear();
  }

  /**
   * Сбрасывает только step-прогресс, храня историю вызовов. Нужно, когда план
   * готов, но цикл продолжается (напр. audit-gate реджектнул готовую задачу):
   * step-stuck варнинги глушатся, а петли повторов всё равно детектятся.
   */
  resetStepProgress(): void {
    this.currentStepId = null;
    this.iterationsOnCurrentStep = 0;
    this.toolErrors.clear();
    this.consecutiveFailures = 0;
    this.recentOutcomes = [];
    this.lastFailedTool = "";
    this.lastErrorOutput = "";
    this.fileRewriteCount.clear();
    this.escalationCount = 0;
    this.lastBashCommand = "";
    this.lastBashOutput = "";
    this.emptyBashRunCount = 0;
    this.bashRecent = [];
    this.errorSignatureCounts.clear();
    this.searchedErrorSignatures.clear();
  }

  /**
   * Сбрасывает всё per-step состояние при переходе на новый шаг. Не даёт
   * ошибкам и повторам одного шага протекать в следующий (ложные
   * stuck/recovery на первой итерации нового шага).
   */
  private resetStepState(stepId: number): void {
    this.currentStepId = stepId;
    this.iterationsOnCurrentStep = 1;
    this.toolErrors.clear();
    this.consecutiveFailures = 0;
    this.recentOutcomes = [];
    this.lastFailedTool = "";
    this.lastErrorOutput = "";
    this.recentToolCalls = [];
    this.fileRewriteCount.clear();
    this.lastBashCommand = "";
    this.lastBashOutput = "";
    this.emptyBashRunCount = 0;
    this.bashRecent = [];
    this.errorSignatureCounts.clear();
    this.searchedErrorSignatures.clear();
    // escalationCount храним — иначе агент "геймит" детекцию, маркируя шаг
    // done и переходя к следующему
  }
}
