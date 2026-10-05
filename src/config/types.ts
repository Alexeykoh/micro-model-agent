// Типы конфига AppConfig: провайдеры, бюджет, MoE, критик, безопасность, UI.
/** Как провайдер предоставляет кеширование промпта. */
export type CacheMechanism = "auto" | "explicit" | "local" | "none";

/**
 * Формат ответа, которым провайдер сообщает о попадании в кеш.
 * `openai` покрывает OpenAI, LM Studio, llama.cpp, vLLM, OpenRouter, Zen/Go и
 * Gemini/xAI — все через OpenAI-совместимую форму.
 */
export type CacheReportFormat = "openai" | "deepseek" | "anthropic" | "ollama" | "none";

/**
 * Возможность кеширования промпта у провайдера. Описывает, КАК работает кеш и
 * что клиент обязан отправить, чтобы агент адаптировался под провайдера (см.
 * docs/specs/2026-09-17-prompt-caching-budget.md). Запросные флаги по
 * умолчанию false: включение — опция, потому что часть бэкендов (llama.cpp
 * `cache_prompt`) обменивает детерминизм на переиспользование.
 */
export interface CacheCapability {
  mechanism: CacheMechanism;
  report: CacheReportFormat;
  /** Слать `x-opencode-session` для кеш/sticky-маршрутизации (OpenCode Zen/Go). */
  sessionHeader: boolean;
  /** Слать `cache_prompt: true` в теле (llama.cpp). */
  requestCachePrompt: boolean;
  /** Слать `prompt_cache_key` в теле (OpenAI). */
  requestPromptCacheKey: boolean;
  /** Слать `session_id` в теле для sticky-маршрутизации (OpenRouter). */
  requestSessionId: boolean;
  /** Помечать блоки контента `cache_control` (Anthropic). */
  requestCacheControl: boolean;
  /**
   * Слать `stream_options: { include_usage: true }` в стриминге, чтобы бэкенд
   * вернул финальный usage-чанк (иначе многие OpenAI-совместимые серверы,
   * включая LM Studio, не отдают usage/`cached_tokens` в стриме).
   */
  requestStreamUsage: boolean;
}

/**
 * Возможности конкретной модели, уточняющие пресет провайдера. Единый
 * источник правды для тулов (например, browser/screenshot) вместо эвристики
 * по имени модели. Поля необязательны: слой может уточнять только часть.
 * Приоритет резолва — см. `resolveModelCapabilities`.
 */
export interface ModelCapabilities {
  /** Модель принимает изображения (image парты в сообщениях). */
  vision?: boolean;
  /** Модель умеет вызывать инструменты. */
  tools?: boolean;
}

/** Одна настроенная запись провайдера (из возможных многих). */
export interface ProviderEntry {
  /** Тип из реестра: "openai-compat" | "openrouter" | "openai" | "opencode-zen" | ... */
  type: string;
  /** Имя для пользователя (пустое = тип). */
  label?: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow?: number;
  retry?: RetryConfig;
  rateLimits?: RateLimitConfig;
  /** Потолок completion-токенов, шлётся как max_tokens (дефолт 8192). Подними для
   *  reasoning-моделей, режущих аргументы tool_call. */
  maxCompletionTokens?: number;
  /** Порядок фолбэка (меньше = пробуется раньше). */
  priority?: number;
  /** Переопределения кеша для записи, накладываются на пресет провайдера. */
  cache?: Partial<CacheCapability>;
}

export interface ProviderConfig {
  /**
   * Имя/лейбл активного провайдера (совпадает с `ProviderEntry.label` или
   * `.type`). Без `entries` — legacy-конфиг одного провайдера, действуют
   * `type`/`baseUrl`/`apiKey`.
   */
  active?: string;
  /** Все настроенные провайдеры (мультирежим). */
  entries?: ProviderEntry[];
  /**
   * Последняя модель каждого провайдера (имя — `label` или `type`). Пишется при
   * каждой смене активной модели, чтобы переключение провайдеров возвращало
   * каждому его модель.
   */
  models?: Record<string, string>;
  /** Автофейловер на следующий провайдер при 429/5xx (дефолт false). */
  fallback?: boolean;
  // Legacy-плоские поля одного провайдера — продолжают работать (зеркалят активную запись).
  type: string;
  baseUrl: string;
  apiKey?: string;
  /** Legacy-плоский потолок completion (зеркалится в нормализованную запись). */
  maxCompletionTokens?: number;
}

/** Цена модели в USD за 1M токенов. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Цена чтения из кеша (cache read). По умолчанию равна input. */
  cachedInput?: number;
  /** Цена записи в кеш (cache write). По умолчанию 0 (бесплатно). */
  cacheWrite?: number;
}

/**
 * Тарифы / трекинг стоимости. `overrides` — ручные цены по моделям (USD за 1M
 * токенов); `builtin` покрывает известных провайдеров (OpenCode Zen / Go).
 * Нет цены — стоимость не показывается.
 */
export interface PricingConfig {
  /** Мастер-выключатель трекинга и показа стоимости. */
  enabled: boolean;
  /** Пользовательские цены по моделям (id модели -> {input, output}). */
  overrides: Record<string, ModelPrice>;
}

export interface OrchestratorConfig {
  model?: string;
  provider?: ProviderConfig;
  /** Окно контекста модели оркестратора (дефолт 32768; запись перекрывает). */
  contextWindow?: number;
}

export interface ContextBudget {
  systemPrompt: number;
  responseReserve: number;
  compactionThreshold: number;
  /**
   * Минимальная загрузка истории (доля), при которой срабатывает интервальная
   * компакция по итерациям. Дефолт 0.5. Не даёт компактить слабозагруженный
   * контекст лишь потому, что прошло N итераций.
   */
  compactionMinLoad?: number;
  /**
   * Политика компакции: `legacy` — поведение 2.18.2, `v2` (дефолт) —
   * канонический порог по истории, cooldown, гарантия прогресса, pinning.
   */
  policy?: "legacy" | "v2";
  /** Мин. число итераций между overflow-компакциями (v2). Дефолт = FORCED_COMPACTION_COOLDOWN. */
  overflowCooldown?: number;
  /** Сколько последних tool-результатов не чистить при компакции (v2). Дефолт 6. */
  toolResultKeep?: number;
  /** Число вызовов прогрева калибровки (cold/warming). Дефолт 3. */
  calibrationWarmup?: number;
  /** Нижняя граница калибровки как доля raw. Дефолт 0.5. */
  ratioFloor?: number;
}

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

export interface MoeConfig {
  enabled: boolean;
  /** Макс. циклов план→выполнение→проверка за MoE-прогон (стартовый цикл + N-1 репланов). */
  maxReplanCycles?: number;
}

export interface ToolsConfig {
  /**
   * Теги тулов, всегда видимые LLM в главном цикле агента. Тулы вне этих тегов
   * (и не `alwaysOn`) скрыты из схемы и включаются по требованию через тул
   * `enable_tools` либо уходят MoE-экспертам / субагентам.
   */
  defaultTags: string[];
  /**
   * Мастер-выключатель ондеманд-тула `enable_tools`. При false тул не
   * регистрируется, набор тегов пуст — возвращается legacy-поведение показа
   * всех зарегистрированных тулов.
   */
  enableOnDemand: boolean;
}

export interface ExpertConfig {
  model: string;
  tool_tags: string[];
  max_attempts?: number;
  /** Однострочная сводка возможностей для промпта MoE-планировщика. */
  description?: string;
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
   * Болтливый внутренний статус: фазы MoE-планирования/выполнения и прочие
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
}

export interface BashSecurityConfig {
  enabled: boolean;
  blacklist: string[];
  whitelist: string[];
  blockDangerousFlags: boolean;
  logCommands: boolean;
  dangerousFlags: string[];
  dangerousOperators: string[];
}

export interface PathSecurityConfig {
  enabled: boolean;
  denied: string[];
  allowed: string[];
}

export interface NetworkSecurityConfig {
  enabled: boolean;
  deniedDomains: string[];
  allowedDomains: string[];
  requestTimeout: number;
  maxResponseSize: number;
}

/**
 * Мастер-выключатель веб-поиска. При enabled=false тул web_search отвечает
 * "disabled", а автопоиск ошибок (errorWebSearch) не стреляет: фича завязана
 * на этот флаг.
 */
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

export interface RateLimitConfig {
  maxRequestsPerMinute: number;
  maxParallelTasks: number;
}

export interface ContentScanConfig {
  enabled: boolean;
  dangerousPatterns: RegExp[];
}

export interface SecurityConfig {
  enabled: boolean;
  bash: BashSecurityConfig;
  paths: PathSecurityConfig;
  network: NetworkSecurityConfig;
  maxRecursionDepth: number;
  maxFileOperations: number;
  rateLimits: RateLimitConfig;
  contentScan: ContentScanConfig;
  sessionEncryption: SessionEncryptionConfig;
  auditNotifier: AuditNotifierConfig;
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
}

export interface SessionIsolationConfig {
  enabled: boolean;
  isolatePlugins: boolean;
  isolateTempFiles: boolean;
}

export interface SessionEncryptionConfig {
  enabled: boolean;
  encryptHistory: boolean;
  encryptSessionLog: boolean;
  keyPath?: string;
}

export type AuditEventType =
  | "security_block"
  | "bash_command"
  | "file_operation"
  | "network_request"
  | "tool_call"
  | "authentication"
  | "configuration_change"
  | "session_start"
  | "session_end";

export interface AuditNotifierConfig {
  enabled: boolean;
  filePath?: string;
  webhookUrl?: string;
  webhookTimeout?: number;
  minSeverity?: "low" | "medium" | "high" | "critical";
  eventTypes?: AuditEventType[];
  maxRetries?: number;
}

import type { LspConfig, } from "../modules/lsp/types";

export interface UpdaterConfig {
  enabled: boolean;
  /** Проверка обновлений асинхронно на старте (не блокирует). */
  checkOnStart: boolean;
  /** Автозапуск `npm install -g` при найденной новой версии. */
  autoInstall: boolean;
  /** Мс между фоновыми проверками. 0 = одна проверка на старте. */
  intervalMs: number;
}

/** Уровни reasoning-усилия, совместимые с opencode + OpenAI API. */
export type ReasoningLevel = "default" | "none" | "low" | "medium" | "high" | "max";

/**
 * Как провайдер выражает reasoning-усилие в запросе API.
 * - "openai-effort": поле `reasoning_effort` в теле (OpenAI, OpenRouter, vLLM);
 * - "template-kwarg": бэкенд-специфичное поле тела (llama.cpp `chat_template_kwargs`);
 * - "prompt-tag": тег в конце последнего user-сообщения (`/no_think` для Qwen);
 * - "none": не поддерживается — фича выключена.
 */
export type ReasoningStrategy = "openai-effort" | "template-kwarg" | "prompt-tag" | "none";

/** Режим: "auto" — динамическое управление политикой; прочее — фикс. уровень. */
export type ReasoningMode = ReasoningLevel | "auto";

export interface ReasoningConfig {
  /** Активный режим. "auto" — политика харнесса крутит уровень по итерациям. */
  mode: ReasoningMode;
  /** Минимум в auto-режиме (нижний кламп). */
  min: Exclude<ReasoningLevel, "default" | "auto">;
  /** Максимум в auto-режиме (верхний кламп). */
  max: Exclude<ReasoningLevel, "default" | "auto">;
  /** Мин. итераций между оверрайд-вызовами агента. */
  overrideCooldown: number;
  /**
   * Стартовый уровень auto-политики до сигналов итераций (итерация 1 и тихие
   * итерации). Без значения — фолбэк на `min` ("low" в `DEFAULTS`): тривиальные
   * Q&A-ходы больше не платят "medium"; политика всё равно поднимает до high
   * на галлюцинациях / отклонениях аудита / создании плана.
   */
  baseline?: Exclude<ReasoningLevel, "default" | "auto">;
}

export interface CriticConfig {
  enabled: boolean;
  /**
   * Выделенный провайдер критика (Phase 2). Полный конфиг провайдера — entries[]
   * или legacy {type,baseUrl,apiKey} — резолвится через ProviderManager, как
   * MoE-оркестратор. Используется только при заданном `model`; иначе критик
   * делит активный провайдер (поведение v1).
   */
  provider?: ProviderConfig;
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
  timeoutMs: number;
}

export interface AppConfig {
  version: string;
  model: string;
  provider: ProviderConfig;
  orchestrator: OrchestratorConfig;
  moe: MoeConfig;
  experts: Record<string, ExpertConfig>;
  /**
   * Переопределения возможностей по моделям (ключ — id модели). Самый приоритетный
   * источник в `resolveModelCapabilities`: бьёт живой пробник и пресет провайдера.
   * Позволяет пригвоздить vision/tools модели, где пресет/пробник ошибаются.
   */
  modelCapabilities?: Record<string, ModelCapabilities>;
  tools: ToolsConfig;
  contextWindow: number;
  contextBudget: ContextBudget;
  instructions: InstructionsConfig;
  modelLoad: ModelLoadConfig;
  retry: RetryConfig;
  maxToolIterations: number;
  stuckThreshold: number;
  autoPlan: boolean;
  /** Настройки execution-модуля (владение статусом плана). */
  execution?: {
    /**
     * Харнесс автоматически помечает шаг done по факту существования файловых
     * деливераблов. При false — только nudge, статус ставит модель. Дефолт true.
     */
    autoAdvance?: boolean;
  };
  showReasoning: boolean;
  logLevel: string;
  locale: string;
  session: SessionConfig;
  contextLog: ContextLogConfig;
  indexer: IndexerConfig;
  browser: BrowserToolConfig;
  webSearch?: WebSearchConfig;
  errorWebSearch?: ErrorWebSearchConfig;
  pricing?: PricingConfig;
  ui: UiConfig;
  mcpServers: Record<string, MCPServerConfigEntry>;
  security?: SecurityConfig;
  sessionIsolation?: SessionIsolationConfig;
  skills: SkillsConfig;
  subagent: SubagentConfig;
  hallucination?: HallucinationConfig;
  lsp?: LspConfig;
  updater: UpdaterConfig;
  reasoning?: ReasoningConfig;
  critic: CriticConfig;
}
