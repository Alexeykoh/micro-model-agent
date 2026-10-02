/**
 * Канонический реестр таймаутов: все дефолтные ожидания/окна в миллисекундах.
 *
 * Правило: любое захардкоженное ожидание живёт здесь под именем с единицей
 * измерения в суффиксе (`*_MS`), а модули импортируют его вместо локальных
 * `const`. Значения — ровно те, что были захардкожены (поведение 1:1);
 * реестр не перенастраивает поведение, только убирает дубли.
 * Сгруппировано по доменам: llm, tools, mcp, lsp, browser, webui, misc.
 */

/** Домены реестра таймаутов (для навигации по файлу). */
export type TimeoutDomain =
  | "llm"
  | "tools"
  | "mcp"
  | "lsp"
  | "browser"
  | "webui"
  | "misc";

/* ── llm ─────────────────────────────────────────────────────────────── */

/** Таймаут одного LLM-запроса (было `REQUEST_TIMEOUT_MS` в openai-compat). */
export const LLM_REQUEST_TIMEOUT_MS = 120000;
/** Макс. ожидание собственного rate-limit слота перед сдачей (openai-compat). */
export const LLM_MAX_RATE_WAIT_MS = 30_000;
/** TTL кэша каталога models.dev: перечитывать после 24 часов (models-dev). */
export const MODELS_DEV_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
/** Дефолтный таймаут запроса каталога models.dev (models-dev, был инлайн `?? 10000`). */
export const MODELS_DEV_FETCH_TIMEOUT_MS = 10000;
/** Дефолтный таймаут запросов баланса провайдера (provider-budget). */
export const PROVIDER_BUDGET_TIMEOUT_MS = 5000;

/* ── tools ───────────────────────────────────────────────────────────── */

/** Окно автобэкграунда bash: команда, живая после него, уходит в фон. */
export const BASH_GRACE_MS = 5000;
/** Короткое окно для явного `background: true` — ловит ошибки спавна. */
export const BASH_SPAWN_SETTLE_MS = 100;
/** Дефолтный таймаут выполнения тула в исполнителе. */
export const TOOL_EXECUTION_TIMEOUT_MS = 60000;
/** Время жизни мемо-записи успешных read-only тулов. */
export const TOOL_MEMO_TTL_MS = 120000;
/** Дефолтное ожидание тула process_wait. */
export const PROCESS_WAIT_DEFAULT_MS = 30000;
/** Верхняя граница ожидания тула process_wait (кламп). */
export const PROCESS_WAIT_MAX_MS = 110000;

/* ── mcp ─────────────────────────────────────────────────────────────── */

/** Таймаут первичного discovery тулов MCP-серверов (не вешать старт). */
export const MCP_DISCOVERY_TIMEOUT_MS = 5_000;
/** Дефолтный таймаут MCP HTTP-запросов (коннект + вызовы тулов). */
export const MCP_HTTP_TIMEOUT_MS = 10_000;

/* ── lsp ─────────────────────────────────────────────────────────────── */

/** Дефолтный таймаут LSP-запроса (был `DEFAULT_TIMEOUT` в client). */
export const LSP_DEFAULT_TIMEOUT_MS = 15000;
/** Кап таймаута пробы LSP-сервера (probe). */
export const LSP_PROBE_TIMEOUT_MS = 30_000;
/** Общий дедлайн пробы LSP-серверов (probe). */
export const LSP_PROBE_DEADLINE_MS = 60_000;
/** Общий кап стартового health-check — старт сессии дольше не блокируем. */
export const LSP_STARTUP_CHECK_TIMEOUT_MS = 60_000;
/** Кап таймаута одного сервера в `/lsp doctor`. */
export const LSP_DOCTOR_TIMEOUT_MS = 20_000;
/** Общий дедлайн `/lsp doctor` (ограничивает ожидание на битых серверах). */
export const LSP_DOCTOR_DEADLINE_MS = 45_000;

/* ── browser ─────────────────────────────────────────────────────────── */

/** Таймаут одного запроса к node-мосту браузера. */
export const BROWSER_BRIDGE_REQUEST_TIMEOUT_MS = 30000;
/** Таймаут прямого запуска Playwright до отката на node-мост. */
export const BROWSER_DIRECT_LAUNCH_TIMEOUT_MS = 8000;

/* ── webui ───────────────────────────────────────────────────────────── */

/** Интервал флаша буферизованных SSE-чанков (`mma web`). */
export const WEBUI_FORWARD_FLUSH_MS = 350;

/* ── misc ────────────────────────────────────────────────────────────── */

/** TTL кэша имён файлов факт-чекера галлюцинаций. */
export const HALLUCINATION_NAME_CACHE_TTL_MS = 5_000;
/** Кулдаун перескана ФС факт-чекера галлюцинаций. */
export const HALLUCINATION_RESCAN_COOLDOWN_MS = 2_000;
/** Таймаут LLM-судьи консистентности. */
export const HALLUCINATION_JUDGE_TIMEOUT_MS = 15000;
/** Дебаунс фонового typecheck после записи (lint-on-write). */
export const LINT_TYPE_CHECK_DEBOUNCE_MS = 2000;
/** TTL кэша пробы поддержки reasoning (повторная проба через 24 часа). */
export const REASONING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Минимальный интервал между автопоисками ошибок (execution-модуль). */
export const EXECUTION_ERROR_SEARCH_MIN_INTERVAL_MS = 30000;
/** Таймаут скана одного локального порта (setup discovery). */
export const SETUP_SCAN_TIMEOUT_MS = 2000;
/** Таймаут запроса списка моделей провайдера (setup discovery). */
export const SETUP_MODELS_TIMEOUT_MS = 5000;
/** Таймаут дешёвой chat-пробы провайдера (setup discovery). */
export const SETUP_CHAT_TIMEOUT_MS = 10000;
