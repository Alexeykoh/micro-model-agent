// Дефолты конфига: единственная точка правды для всех опций AppConfig.
import type { AppConfig } from "./types";
import { DEFAULT_SECURITY_CONFIG } from "./security";
import { DEFAULT_LSP_CONFIG } from "../modules/lsp/config";

/** Дефолтная модель (эксперты наследуют её). */
const DEFAULT_MODEL = "qwen/qwen3.5-9b";

/** Дефолтный конфиг. Глубоко мержится с пользовательским при загрузке. */
export const DEFAULTS: AppConfig = {
  version: "2.0.0",
  model: DEFAULT_MODEL,
  provider: {
    type: "openai-compat",
    baseUrl: "http://localhost:1234/v1",
    apiKey: "not-needed",
  },
  orchestrator: {
    model: undefined,
    provider: undefined,
  },
  moe: {
    enabled: false,
    maxReplanCycles: 3,
  },
  critic: {
    enabled: true,
    // Phase 2: выделенные provider/model — opt-in; пока не заданы, делит активный
    // провайдер (поведение v1). Read-only verify-цикл включён: запускается только
    // после вердикта concern/critical, ограничен и fail-open.
    provider: undefined,
    model: undefined,
    tools: true,
    maxCalls: 4,
    maxRepairCycles: 1,
    timeoutMs: 15000,
  },
  tools: {
    // Автосужение P5 (2026-09-28): enableOnDemand:true показывает только
    // defaultTags + alwaysOn структурные/интерактивные тулы; теги под тип задачи
    // детерминированно досеиваются до первого вызова LLM (src/tools/auto-tags.ts),
    // а модель расширяет набор через enable_tools. Дрейф 9B, вызвавший откат
    // (скрытые тулы звались как shell-команды), гасится блоком промпта про скрытые
    // тулы, хинтом bash про скрытые тулы + редиректом tool-call и alwaysOn
    // question/approve.
    defaultTags: ["file", "code"],
    enableOnDemand: true,
    grepEngine: "auto",
  },
  experts: {
    code: {
      model: DEFAULT_MODEL,
      tool_tags: ["file", "code", "shell"],
      max_attempts: 3,
      description: "file operations, code editing, shell commands",
    },
    research: {
      model: DEFAULT_MODEL,
      tool_tags: ["research"],
      max_attempts: 3,
      description: "web search, web fetch, web browse, history search",
    },
    browser: {
      model: DEFAULT_MODEL,
      tool_tags: ["browser", "vision"],
      max_attempts: 3,
      description: "browser automation, screenshots",
    },
    vision: {
      model: DEFAULT_MODEL,
      tool_tags: ["browser", "vision", "file"],
      max_attempts: 2,
      description: "browser + file reading for visual tasks",
    },
  },
  // Переопределения возможностей по моделям (ключ — id модели). Пусто по
  // умолчанию: первичны живой native-probe (LM Studio) и пресет провайдера,
  // эта карта — ручной escape hatch, когда оба ошиблись.
  modelCapabilities: {},
  contextWindow: 32768,
  // Авто-детект окна у провайдера включён: проба на старте/смене модели
  // уточняет настроенное значение (см. contextAuto в types.ts).
  contextAuto: true,
  contextBudget: {
    systemPrompt: 0.1,
    responseReserve: 0.15,
    compactionThreshold: 0.75,
    compactionMinLoad: 0.5,
    policy: "v2",
    compactionSummary: "ledger",
    overflowCooldown: 3,
    toolResultKeep: 6,
    calibrationWarmup: 3,
    ratioFloor: 0.5,
  },
  instructions: {
    summarize: true,
  },
  modelLoad: {
    autoLoad: false,
    flashAttention: true,
    offloadKvCacheToGpu: true,
  },
  retry: {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 30000,
    maxStreamRetries: 2,
    noDataTimeoutMs: 180000,
  },
  maxToolIterations: 1000,
  stuckThreshold: 6,
  autoPlan: true,
  execution: {
    autoAdvance: true,
  },
  showReasoning: true,
  logLevel: "info",
  locale: "en",
  session: {
    autoSave: true,
    maxSessions: 50,
    isolateMemory: false,
    autoName: true,
  },
  contextLog: {
    enabled: false,
    redact: true,
  },
  indexer: {
    maxFiles: 5000,
    respectGitignore: true,
    mapTokenBudget: 1500,
  },
  // Ретенция изображений тулов (browser screenshot / attach_image) на сессию:
  // последние 30 картинок или до 100 МБ, что наступит раньше.
  images: {
    maxCount: 30,
    maxBytes: 104_857_600,
  },
  browser: {
    enabled: true,
    headless: true,
    maxElements: 30,
    maxContentChars: 2500,
    maxConsoleEntries: 40,
    maxConsoleLineChars: 400,
    viewportWidth: 1280,
    viewportHeight: 720,
    navigationTimeout: 15000,
  },
  webSearch: {
    enabled: true,
  },
  errorWebSearch: {
    enabled: true,
    threshold: 5,
    maxResults: 5,
    maxQueryChars: 200,
    maxSearchesPerSession: 3,
    requestTimeoutMs: 10000,
  },
  pricing: {
    enabled: true,
    overrides: {},
  },
  ui: {
    spinner: true,
    activityRail: "line",
    showContextStats: false,
    showCompaction: true,
    verbose: false,
    verbosity: "quiet",
    fontSize: "comfortable",
  },
  mcpServers: {},
  security: DEFAULT_SECURITY_CONFIG,
  sessionIsolation: {
    enabled: false,
    isolateTempFiles: true,
  },
  skills: {
    budget: 0.15,
  },
  plugins: {
    disabled: [],
    maxDrafts: 10,
  },
  hallucination: {
    judge: {
      enabled: false,
    },
  },
  subagent: {
    resultMode: "text",
    maxSummaryChars: 2000,
    artifactsDir: ".mma/artifacts",
    stableSystemPrompt: true,
    maxParallelChunkQueries: 4,
    timeoutMs: 180000,
  },
  lsp: DEFAULT_LSP_CONFIG,
  updater: {
    enabled: true,
    autoInstall: false,
    intervalMs: 0,
  },
  reasoning: {
    mode: "auto",
    min: "low",
    max: "high",
    overrideCooldown: 5,
    // Тривиальные Q&A-ходы не должны платить за medium reasoning; политика всё
    // равно поднимает до high на галлюцинациях/отклонениях аудита/создании плана.
    baseline: "low",
  },
  service: {
    port: 7331,
    host: "127.0.0.1",
    token: undefined,
    resultRetentionDays: 7,
    idempotencyTtlHours: 24,
    syncWaitMs: 10_000,
    maxQueueLength: 5,
    callbackTimeoutMs: 10_000,
    webhookSecret: undefined,
  },
};
