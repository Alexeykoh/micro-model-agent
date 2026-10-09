/** Базовые типы ядра: состояния, тулы, ответы LLM, результаты. */
/** Состояние агентного цикла. */
export type AgentState = "INIT" | "THINK" | "ACT" | "OBSERVE" | "OUTPUT" | "ERROR";

/**
 * Вид мета-канала: тела тулов (`display`/`output`/`diff`/сводка из `ToolBatch`)
 * — model-facing, в quiet-чатах скрываются; настоящий статус (статистика
 * контекста, компакция, варнинги) виден всегда. `retract` — гейт забраковал
 * уже отстримленный черновик и переспрашивает модель: потребители убирают
 * черновик из ленты (иначе финал встанет дублем следом).
 */
export type MetaKind = "tool" | "status" | "retract";

/** Колбэк UI-статуса; `kind` по умолчанию `"status"`. */
export type OnMeta = (meta: string, kind?: MetaKind) => void;

/**
 * Семантический класс блока промпта — резолвер переполнения обрабатывает
 * инструкции/карту особо, когда они рвут системный бюджет.
 */
export type PromptBlockKind = "instructions" | "project-map";

/** Блок системного промпта: контент, приоритет, оценка токенов. */
export interface PromptBlock {
  content: string;
  priority: "critical" | "high" | "normal" | "low";
  essential: boolean;
  estimatedTokens: number;
  kind?: PromptBlockKind;
}

/** Статус вызова тула. */
export type ToolCallStatus = "done" | "failed" | "skipped";

/** Вызов тула от модели: id, имя, аргументы. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Событие тула для UI (старт/конец, длительность, дельта контекста). */
export interface ToolEvent {
  type: "start" | "end";
  tool: string;
  args: Record<string, unknown>;
  icon?: string;
  duration?: number;
  error?: boolean;
  ctxDelta?: number;
  /** Сырое тело результата на `end`; рендереры режут/чистят перед показом. */
  output?: string;
  /**
   * Ref'ы сохранённых изображений тулов (session `<id>/images/`) — веб рисует
   * их как URL, история сохраняет для replay.
   */
  imageRefs?: import("../modules/session/image-store").ToolImageRef[];
  /**
   * Model data-URL'ы из `ToolResult.images` — фолбэк live-показа без персиста
   * (шифрованная сессия: картинки не пишутся на диск).
   */
  images?: import("../llm/provider").ImageUrlPart[];
  /** Накопленная стоимость сессии в USD на момент конца тула (если цена известна). */
  costUsd?: number;
  /** Провайдер вызова тула (мультипровайдерный режим). */
  provider?: string;
  /** Модель вызова тула. */
  model?: string;
}

/** Фазы жизни агента для рендерера (управление спиннером). */
export type AgentPhase = "thinking" | "done";

/** Результат тула: успех, вывод, id вызова. */
export interface ToolResult {
  success: boolean;
  output: string;
  toolCallId?: string;
}

/** Ответ LLM: текст, вызовы тулов или reasoning. */
export type LLMResponse =
  | { type: "text"; content: string }
  | { type: "tool_call"; calls: ToolCall[] }
  | { type: "reasoning"; content: string };

/** Контекст агента: состояние, конфиг, сообщения, счётчик итераций. */
export interface AgentContext {
  state: AgentState;
  config: import("../config/types").AppConfig;
  messages: Array<{ role: string; content: string | import("../llm/provider").ContentPart[] }>;
  toolResults: ToolResult[];
  iterationCount: number;
  currentStep?: number;
  totalSteps?: number;
}

/** Вердикт детектора халлюцинаций: pass/warn/retry/block. */
export interface HallucinationResult {
  status: "pass" | "warn" | "retry" | "block";
  reason?: string;
}

/** Контекст сабтаска MoE: эксперт, теги тулов, файлы, зависимости. */
export interface SubtaskContext {
  expert_tag: string;
  tool_tags: string[];
  allowed_files: string[];
  read_only_files: string[];
  shared_context?: {
    rules: string[];
    refs: string[];
  };
  input_from?: string[];
}

/**
 * Сегментная разбивка контекста по частям (для полосы в UI/сайдбаре).
 * Инвариант: `system + tools + history === used` (system — часть сообщений),
 * `reserve` — отдельный бюджет ответа, `free` — остаток бюджета истории.
 */
export interface ContextBreakdown {
  /** Токены системного сообщения (промпт, AGENTS.md). */
  system: number;
  /** Токены определений тулов (схемы JSON). */
  tools: number;
  /** Токены сообщений истории (всё, кроме system). */
  history: number;
  /** Всего занято = system + tools + history. */
  used: number;
  /** Бюджет системного промпта. */
  systemBudget: number;
  /** Бюджет истории. */
  historyBudget: number;
  /** Зарезервировано под ответ модели. */
  reserve: number;
  /** Свободный остаток бюджета истории (не ниже нуля). */
  free: number;
  /** Полное окно контекста. */
  window: number;
}

/**
 * Причина принудительного завершения хода харнессом: дубль-петля,
 * серия провальных пакетов или исчерпание итераций.
 */
export type StopReason = "duplicate" | "failed_batches" | "max_iters";

/** Итог прогона: успех, текст, токены, стоимость, качество контекста. */
export interface AgentResult {
  success: boolean;
  /**
   * Ход был прерван пользователем (`shutdown`/AbortError), а не завершён
   * штатно. `success` при обрыве остаётся `false`, но потребители показывают
   * «остановлено», а не «ошибку» (веб-лента, CLI).
   */
  interrupted?: boolean;
  /**
   * Харнесс завершил ход принудительно (дубль-петля / серия провалов /
   * исчерпание итераций). Ответ — лучшее из собранного, без проверки тулами.
   */
  stopReason?: StopReason;
  text: string;
  error?: string;
  iterationCount: number;
  contextUsed?: number;
  contextLimit?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Накопленная стоимость сессии в USD (нет, если цена модели неизвестна). */
  totalCost?: number;
  /** Разбивка стоимости по провайдерам (только с ценами, по убыванию). */
  costBreakdown?: Array<{ provider: string; cost: number }>;
  /** Статистика кеша промпта за прогон (провайдерская или client-side). */
  cache?: {
    cachedTokens: number;
    uncachedTokens: number;
    cacheWriteTokens: number;
    /**
     * cached / (cached + uncached), 0..1. Отсутствует, когда провайдер не
     * сообщил cache-токенов: «нет данных» — не «промах». Потребители (сайдбар,
     * футер CLI) обязаны в этом случае показывать прочерк, а не `0%`.
     */
    hitRate?: number;
    /** Экономия в USD относительно полной input-цены (если цена известна). */
    saved?: number;
    /** Стабильность префикса последней итерации (0..1), client-side. */
    prefixStable?: number;
    /** Причина расхождения префикса. */
    prefixCause?: string;
    /** Источник кеш-данных. */
    source: "api" | "derived" | "none";
  };
  compactionCount?: number;
  contextQuality?: number;
  /** Сегментная разбивка контекста (system/tools/history/reserve/free). */
  contextBreakdown?: ContextBreakdown;
  /** Провайдер этого прогона. */
  provider?: string;
  /** Модель этого прогона. */
  model?: string;
  /** Полная длительность в миллисекундах (wall-clock). */
  durationMs?: number;
  /** Длительность LLM-вызовов в мс (без исполнения тулов). */
  llmDurationMs?: number;
  /**
   * True, если реально отработал MoE-путь (а не фолбэк в одиночный цикл).
   * По нему Agent.run понимает, что должен сам записать ход ассистента
   * в контекст/сессию (одиночный цикл пишет сам).
   */
  moeHandled?: boolean;
}
