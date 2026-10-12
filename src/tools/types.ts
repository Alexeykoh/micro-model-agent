/** Контракты тулов: определения, контекст, результаты, хуки плагинов. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * Владелец тула (INV-1/2): `core` для встроенных, имя модуля (`execution`,
   * `mcp`, …), `plugin:<name>` для вклада плагина. Штампуется на пути
   * регистрации; реестр отказывает тулу без владельца — у каждого тула один
   * источник истины.
   */
  owner?: string;
  /** Иконка в заголовке тула. Без неё — маркер из `toolMarker()`. */
  icon?: string;
  tags?: string[];
  /**
   * Тулы вне tag-фильтрации (getAllForLLM/getByTags/filterToolsByTags).
   * Структурные тулы (plan/todo/verify/project_map/lsp_check/enable_tools) —
   * alwaysOn, чтобы сужение набора не ломало план и LSP-проверки.
   */
  alwaysOn?: boolean;
  /** Интерактивный тул: ждёт ввода пользователя, без таймаута выполнения. */
  interactive?: boolean;
  /**
   * Таймаут тула в мс. Дефолт — TOOL_EXECUTION_TIMEOUT_MS (60с) исполнителя
   * (см. `src/config/timeouts.ts`).
   * Для тулов с несколькими LLM-вызовами (напр. chunk_query) на медленных провайдерах.
   * Может быть функцией от контекста — для тулов, чей таймаут берётся из конфига
   * (напр. subagent.timeoutMs).
   */
  timeoutMs?: number | ((ctx: ToolContext) => number);
  /**
   * Тул сам ограничивает размер вывода (лимиты строк/записей/хвоста).
   * Усечение по бюджету к таким тулам применять нельзя: почти полный контекст
   * резал read_file до ~2K символов, и модель бесконечно перечитывала файл.
   */
  boundedOutput?: boolean;
  /**
   * Детерминированный read-only тул: исполнитель мемоизирует успешные результаты
   * (ключ — сессия + имя + аргументы, TTL 120с) и отдаёт повторы без перезапуска.
   * Помечать только немутирующие тулы со стабильным выводом; любое некешируемое
   * выполнение сбрасывает мемо. Для модели поведение не меняется.
   */
  cacheable?: boolean;
  /**
   * Тул сам управляет мемо через `ctx.toolExecutor` (`memoGet`/`memoSet`/
   * `memoInvalidate`), т.к. кешируемость зависит от аргументов (bash: `npm view`
   * кешируем, `npm publish` — нет). Исполнитель автосброс для таких тулов
   * пропускает — инвалидация на самом туле.
   */
  manualMemo?: boolean;
  /**
   * Тул можно выполнять конкурентно с соседями по batch'у (один ход модели).
   * `ToolBatchExecutor` группирует подряд идущие такие вызовы (≥2) и запускает
   * их через `Promise.all` на изолированных `ToolExecutor.fork()`. Помечать
   * только тулы без общего мутабельного состояния (subagent — свой контекст и
   * scope на форке). Остальные остаются строго последовательными.
   */
  parallelizable?: boolean;
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

/** Область видимости тула: разрешённые и read-only файлы. */
export interface ToolScope {
  allowed_files: string[];
  read_only_files: string[];
}

/** Контекст выполнения тула: конфиг, провайдер, логгер, сессия, скоуп. */
export interface ToolContext {
  config: import("../config/types").AppConfig;
  baseDir: string;
  logger: import("../logger/app-logger").Logger;
  scope?: ToolScope;
  llmProvider?: import("../llm/provider").LLMProvider;
  toolExecutor?: import("./executor").ToolExecutor;
  contextManager?: import("../modules/context/manager").ContextManager;
  /**
   * Возможности АКТИВНОЙ модели (пресет + живой пробник + override конфига).
   * Тулы, зависящие от способностей модели (browser vision, аттачи картинок),
   * читают это вместо угадывания по имени модели.
   */
  capabilities?: import("../config/types").ModelCapabilities;
  sessionHistory?: {
    append(type: string, content: unknown): Promise<void>;
  };
  /**
   * Добавить структурую запись в лог выполнения сессии (session.jsonl).
   * Для записи прогресса плана (post-mortem анализ).
   */
  sessionLog?: {
    plan(event: string, detail: string, iteration?: number): void;
  };
  /**
   * Headless one-shot: интерактивные тулы (question/approve) падают сразу,
   * не блокируясь на stdin; агент завершается на первом финальном ответе.
   */
  exitOnComplete?: boolean;
  /** Текущая глубина рекурсии субагентов. */
  recursionDepth?: number;
  /** ID сессии для аудит-лога. */
  sessionId?: string;
  /** Счётчик файловых операций для rate limiting. */
  fileOperationsCount?: number;
  /** Контекст сессии для изоляции. */
  sessionContext?: import("../modules/security/session-isolation").SessionContext;
  /**
   * ID выполняемого tool call. Ставит исполнитель, чтобы долгие тулы
   * (напр. bash) можно было убить по таймауту.
   */
  activeCallId?: string;
  /**
   * Общий мутабельный массив тегов, включённых on-demand через `enable_tools`.
   * Цикл агента перечитывает его каждую итерацию для пересчёта видимого LLM
   * набора. Пустой при выключенном on-demand — getAllForLLM отдаёт всё (legacy).
   */
  activeToolTags?: string[];
  /**
   * Строгий allowlist тулов на ход/сессию. Когда задан, модели видны и
   * исполнимы ТОЛЬКО эти имена — `alwaysOn` и теги его НЕ обходят.
   * Для онбординга (запрет трогать репозиторий). Undefined — обычный tag-отбор.
   */
  toolAllowlist?: string[];
  /**
   * Когда задан, write_file/edit_file пишут только в эти абсолютные пути
   * (без учёта регистра). Для онбординга `init` (только AGENTS.md).
   * Undefined — без ограничений.
   */
  writePathAllowlist?: string[];
  /**
   * Общее состояние онбординга. Ставит `meet_done`, читает REPL для выхода
   * из meet-режима. Несёт активный guide-блок для снятия при выходе.
   * Undefined вне онбординга.
   */
  onboarding?: { done: boolean; block?: import("../core/types").PromptBlock };
  /**
   * Опциональный cleanup при таймауте/аборте тула. Для subagent — восстановить
   * скоуп родителя, даже если `finally` агента не отработал (брошенный промис).
   */
  cleanup?: () => void;
  /**
   * Тестовый шов — фабрика инстанса субагента (моки Bun-модулей глобальны
   * на процесс, vi.mock для класса Agent не годится).
   */
  agentFactory?: (deps: unknown) => {
    run(task: string): Promise<import("../core/types").AgentResult>;
  };
  /**
   * Менеджер сессий — метаданные активной сессии для тулов.
   * Добавлен для session_info; минимален во избежание циклических зависимостей.
   */
  sessionManager?: {
    getActiveMeta(): {
      id: string;
      name: string;
      model?: string;
      contextWindow?: number;
      messageCount: number;
      createdAt: string;
      updatedAt: string;
    } | null;
  };
  /**
   * Терминал-независимая поверхность промпта для интерактивных тулов. REPL
   * ставит свою на время вопроса; в headless undefined — тулы падают
   * на legacy readline-путь.
   */
  promptIO?: import("./prompt-io").PromptIO;
  /**
   * Хост черновиков capabilities (`define_capability`). Ставится bootstrap'ом;
   * в тестах и headless без blackboard — undefined, и тул честно отвечает, что
   * недоступен. Узкий интерфейс: контекст тулов не знает про загрузчик плагинов.
   */
  pluginDrafts?: import("../modules/plugins/drafts").DraftHost;
}

/** Результат тула: успех, вывод, вложения, артефакты. */
export interface ToolResult {
  success: boolean;
  output: string;
  toolCallId?: string;
  display?: string;
  diff?: string;
  /**
   * Изображения, произведённые тулом (например, browser screenshot или
   * будущий рендер графика). Доставляются модели отдельным user-сообщением
   * (см. `queueToolImages`), а НЕ строкой base64 внутри `output`: в
   * `role:"tool"` content по контракту OpenAI/Jinja — только текст.
   */
  images?: import("../llm/provider").ImageUrlPart[];
  /**
   * Полноразмерные ассеты для персиста и показа (диск/веб-лента). Модель
   * получает `images` (может быть ресайзнут); вебу и истории нужны оригинальные
   * байты. Заполняется тулом, спаривается ядром в `imageRefs` после записи.
   */
  imageFiles?: import("../modules/session/image-store").ToolImageAsset[];
  /**
   * Ref'ы сохранённых картинок — заполняет ядро после персиста
   * (`SessionLogger.persistToolImages`); читают forwarder и session.jsonl.
   */
  imageRefs?: import("../modules/session/image-store").ToolImageRef[];
  /**
   * True, если `onBeforeTool` плагина отклонил вызов до запуска тула.
   * Это `success:false`, но НЕ признак сломанного действия — плагин может
   * ограждать порядок/скоуп/безопасность. Такие вызовы исключать из учёта
   * failures/retry (иначе транзиентный гард навсегда отучит агента
   * повторять корректное действие).
   */
  blocked?: boolean;
  /** Абсолютный путь сохранённого артефакта (subagent result_mode:"file"). */
  artifactPath?: string;
  /** Токены прогона субагента (атрибуция стоимости по expert_tag). */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /**
   * Структурированная ошибка: код, повторяемость, подсказка. Отдельное
   * model-facing поле — доставляется модели компактной директивой, но НЕ
   * протекает в чат (см. `appendErrorMeta`).
   */
  errorMeta?: { code: string; retryable?: boolean; hint?: string };
}

/** Вызов тула: id, имя, аргументы. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Хук плагина: перехват до/после выполнения тула. */
export interface PluginHook {
  name?: string;
  priority?: number;
  isBuiltin?: boolean;
  /**
   * Вернуть `false` — блокировать тул, строку — блокировать с причиной
   * (видит модель), `true` — разрешить.
   */
  onBeforeTool?(ctx: ToolContext, call: ToolCall): boolean | string | Promise<boolean | string>;
  onAfterTool?(ctx: ToolContext, call: ToolCall, result: ToolResult): void | Promise<void>;
}

/** Менеджер плагинов: доступ к зарегистрированным хукам. */
export interface PluginManager {
  getAllPlugins(): PluginHook[];
}
