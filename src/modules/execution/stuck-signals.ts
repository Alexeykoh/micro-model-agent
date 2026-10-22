/**
 * Сигналы ошибок детектора застревания: классификация, сигнатура, поисковый запрос.
 *
 * Вынесено из stuck-detector.ts (правило 6): чистые функции, не зависящие от
 * состояния детектора.
 */
import { isTransientError } from "./transient-error";

export interface ToolCallRecord {
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
