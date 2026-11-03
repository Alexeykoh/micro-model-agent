// Типы рантайма: инструкции, сессии, тулы, MCP, UI, браузер, субагент, критик, плагины.
import type { ProviderConfig } from "./types-provider";
import type { ThemeMode, UiThemeId } from "./theme-ids";

/**
 * Обработка промпт-блоков (AGENTS.md, карта проекта), превышающих бюджет
 * системного промпта. При включённом `summarize` переполненный блок суммаризирует
 * LLM в остаток бюджета (кеш в `<project>/.mma/cache/prompt-summaries`); при
 * неуспехе блок режется с маркером, а модели хинтится чтение полного файла.
 */
export interface InstructionsConfig {
  summarize: boolean;
}

export interface SessionConfig {
  autoSave: boolean;
  maxSessions: number;
  isolateMemory: boolean;
  /** LLM-уточнение имени сессии после первого сообщения (детерминированное имя — всегда). */
  autoName: boolean;
}

/**
 * Git-подобный лог контекста. При включении каждый снапшот LLM-контекста пишется
 * в `<session>/context.diff`: снапшот 0 — полный контекст (все строки "+"),
 * дальше — построчные диффы (- удалено, + добавлено). `redact` прогоняет
 * контекст через sanitizeLogMessage до записи.
 */
export interface ContextLogConfig {
  enabled: boolean;
  redact: boolean;
}

/** Настройки индексатора карты проекта. */
export interface IndexerConfig {
  /** Кап индексируемых файлов; при достижении карта помечается усечённой. */
  maxFiles: number;
  /** Следовать `.gitignore`/`.mmaignore` корня проекта при обходе. */
  respectGitignore: boolean;
  /** Токен-бюджет списка файлов в карте проекта (PageRank-отбор). */
  mapTokenBudget: number;
}

/** Ретенция изображений тулов на сессию (`<sessionDir>/images`). */
export interface ImagesConfig {
  /** Максимум хранимых картинок на сессию; старейшие вытесняются первыми. */
  maxCount: number;
  /** Максимальный суммарный размер картинок сессии в байтах. */
  maxBytes: number;
}

export interface ModelLoadConfig {
  autoLoad: boolean;
  flashAttention?: boolean;
  evalBatchSize?: number;
  offloadKvCacheToGpu?: boolean;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  /** Доп. ретраи, если стрим ответа рвётся ДО выдачи любого контента. */
  maxStreamRetries?: number;
  /** Макс. тишина (мс) между чанками стрима — дальше соединение считается мёртвым. */
  noDataTimeoutMs?: number;
}

export interface ToolsConfig {
  /**
   * Теги тулов, всегда видимые LLM в главном цикле агента. Тулы вне этих тегов
   * (и не `alwaysOn`) скрыты из схемы и включаются по требованию через тул
   * `enable_tools` либо уходят субагентам.
   */
  defaultTags: string[];
  /**
   * Мастер-выключатель ондеманд-тула `enable_tools`. При false тул не
   * регистрируется, набор тегов пуст — возвращается legacy-поведение показа
   * всех зарегистрированных тулов.
   */
  enableOnDemand: boolean;
  /**
   * Движок поиска для тула `grep`: `auto` (rg → grep → zero-dep JS),
   * `rg`/`grep` (только системный бинарь), `js` (только встроенный обход).
   * Дефолт auto.
   */
  grepEngine?: "auto" | "rg" | "grep" | "js";
}

export interface MCPHeader {
  [key: string]: string;
}

export interface MCPServerConfigEntry {
  /** Имя MCP-сервера (ключ записи). */
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: "stdio" | "sse" | "http";
  url?: string;
  headers?: MCPHeader;
  enabled?: boolean;
  timeout?: number;
}

export interface BrowserToolConfig {
  /** Мастер-выключатель браузерного тула. */
  enabled: boolean;
  headless: boolean;
  maxElements: number;
  maxContentChars: number;
  maxConsoleEntries: number;
  maxConsoleLineChars: number;
  viewportWidth: number;
  viewportHeight: number;
  navigationTimeout: number;
}

export interface UiConfig {
  spinner: boolean;
  /**
   * Activity rail над строкой ввода на время хода: `line` — компактная
   * однострочная (дефолт), `meta` — в строке хинта, `full` — на всю ширину,
   * `off` — скрыт.
   */
  activityRail?: "off" | "line" | "meta" | "full";
  /** Бар использования контекста после каждого цикла тулов (ctx: N/M, компакции, качество). */
  showContextStats: boolean;
  /** Однострочный индикатор при срабатывании компакции контекста. */
  showCompaction: boolean;
  /**
   * Болтливый внутренний статус: фазы планирования/выполнения и прочие
   * однострочники оркестрации. По умолчанию выкл — это для машинного
   * конвейера, а не для пользователя.
   */
  verbose?: boolean;
  /**
   * Уровень болтливости чата. `quiet` — строка на действие, тела тулов скрыты;
   * `verbose` — полные детали. Дефолт `quiet` для свежих конфигов, фолбэк
   * `verbose ? "verbose" : "quiet"`, если не задан. См. `docs/design/ui/STYLE.md`.
   */
  verbosity?: "quiet" | "normal" | "verbose";
  /**
   * Размер шрифта веб-чата (только `mma web`, терминал не затрагивается).
   * `compact` = 13px, `comfortable` = 15px (дефолт), `large` = 17px.
   */
  fontSize?: "compact" | "comfortable" | "large";
  /**
   * Скин веб-UI (`mma web`). Хранится в конфиге, а не только в браузере: тема
   * переживает перезапуск сервера. В браузере значение дублируется кэшем —
   * только для отрисовки до первого `GET /api/config`. Каталог id и подписи —
   * во фронтенде (`assets/js/settings/themes.ts`).
   */
  theme?: UiThemeId;
  /** Режим оформления веб-UI: `dark` | `light` | системный `auto`. */
  themeMode?: ThemeMode;
  /** Звуки веб-UI: мастер и флаги событий (spec 2026-10-31-webui-sounds). */
  sounds?: { enabled?: boolean; done?: boolean; question?: boolean; failed?: boolean };
}

/** Мастер-выключатель веб-поиска: при false web_search отвечает "disabled". */
export interface WebSearchConfig {
  enabled: boolean;
}

export interface ErrorWebSearchConfig {
  /** Независимый выключатель самого автопоиска ошибок. */
  enabled: boolean;
  /** Столько повторов одной сигнатуры ошибки триггерит поиск (5). */
  threshold: number;
  /** Столько результатов инжектится в контекст (5). */
  maxResults: number;
  /** Макс. длина генерируемого поискового запроса (200). */
  maxQueryChars: number;
  /** Потолок автопоисков ошибок за сессию (3). */
  maxSearchesPerSession: number;
  /** Сетевой таймаут поиска в мс (10000). */
  requestTimeoutMs: number;
}

export interface SkillsConfig {
  budget: number;
}

export interface HallucinationConfig {
  judge: {
    /**
     * Прогон LLM-as-judge на консистентность worker-модели. По умолчанию выкл:
     * на маленьких моделях это до +15с латентности ради вердикта, дающего лишь
     * косметический "warn", но не ретрай/блок.
     */
    enabled: boolean;
  };
}

export interface SubagentConfig {
  /**
   * "text" (дефолт, обратно совместимо): текст результата субагента возвращается
   * в родительский контекст. "file": результат складывается в файл-артефакт,
   * а родитель получает путь + ограниченную сводку.
   */
  resultMode: "text" | "file";
  /** Макс. символов сводки, возвращаемой в контекст при resultMode "file". */
  maxSummaryChars: number;
  /** Каталог файлов-артефактов относительно корня workspace. */
  artifactsDir: string;
  /** Держать системный промпт субагента побайтово одинаковым между вызовами (дружелюбно к KV-кешу). */
  stableSystemPrompt: boolean;
  /** Дефолтный потолок параллельных chunk-запросов в runChunkQuery. */
  maxParallelChunkQueries: number;
  /**
   * Idle-таймаут прогона, мс (дефолт 180000): сколько можно не подавать ни одного
   * события (текст/рассуждение/тул/фаза), прежде чем прогон будет остановлен.
   */
  timeoutMs: number;
  /** Жёсткий потолок одного прогона, мс (дефолт 1800000). */
  maxDurationMs: number;
}

export interface UpdaterConfig {
  enabled: boolean;
  /** Скачивать и активировать релиз при найденной новой версии. */
  autoInstall: boolean;
  /** Мс между фоновыми проверками. 0 = одна проверка на старте. */
  intervalMs: number;
}

export interface CriticConfig {
  enabled: boolean;
  /**
   * Выделенный провайдер критика (Phase 2). Полный конфиг провайдера — entries[]
   * или legacy {type,baseUrl,apiKey} — либо имя записи `provider.entries[]`
   * (резолвится `resolveProviderRef`). Используется только при заданном
   * `model`; иначе критик делит активный провайдер (поведение v1).
   */
  provider?: ProviderConfig | string;
  /** Выделенная модель критика. Не задана — активная модель. */
  model?: string;
  /**
   * Read-only verify-цикл (Phase 2): после вердикта concern/critical критик
   * может запросить до MAX_CRITIC_CHECKS read-only проверок тулами
   * (read_file/grep/glob/file_info/list_dir) до финального вердикта.
   */
  tools: boolean;
  /** Жёсткий потолок LLM-вызовов критика за прогон. */
  maxCalls: number;
  /** Ограниченное число critical-ремонтных циклов за прогон. */
  maxRepairCycles: number;
  /**
   * Таймаут **одного** LLM-вызова критика, мс (не на всю цепочку проходов:
   * общий бюджет на длинном пакете ронял второй проход в fail-open).
   */
  timeoutMs: number;
  /** Мин. лимит токенов критика; реальный = max(это, provider.maxCompletionTokens) — INV-C5. */
  maxTokens: number;
}

export interface PluginsConfig {
  /**
   * Имена выключенных плагинов (deny-list). Выключение живое: хуки плагина
   * перестают вызываться, без перезапуска. Модуль при этом уже загружен —
   * disable останавливает поведение, а не исполнение кода (см. `docs/plugins.md`).
   */
  disabled?: string[];
  /**
   * Сколько черновиков capabilities (код, написанный агентом) держим на проект.
   * Лишние вытесняются по LRU. Черновики не выполняются, пока пользователь
   * явно не разрешит их для этого проекта (`mma plugins drafts approve`).
   */
  maxDrafts?: number;
}
