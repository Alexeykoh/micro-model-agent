/**
 * Фаза 4 bootstrap: сессии, context-лог, менеджер контекста и ToolContext.
 *
 * Порядок 1:1 с исходником: SessionStore/SessionManager (+ привязка ленивого
 * session id фазы провайдера, autoSave) → запись context-probe в сессию фоном
 * → ContextLogger (opt-in) → TokenCounter/activeToolTags/ContextManager →
 * общий бокс живого конфига → ToolContext с живыми геттерами (config,
 * sessionId, sessionContext, sessionManager, capabilities) → ToolExecutor →
 * HallucinationDetector.
 *
 * Shared mutable state вынесен вместе с фазой: `configRef` (живой бокс
 * конфига) и сам `toolCtx` возвращаются наружу следующим фазам.
 */
import { join } from "path";
import { ContextManager } from "../../modules/context/manager";
import { TokenCounter } from "../../llm/token-counter";
import { ToolExecutor } from "../../tools/executor";
import { HallucinationDetector } from "../../modules/hallucination/detector";
import { SessionStore, SessionManager } from "../../modules/session/index";
import { BUILTIN_PROVIDERS } from "../../modules/providers/presets";
import { resolveModelCapabilities } from "../../modules/providers/capabilities";
import { ContextLogger } from "../agent/context-log";
import { t } from "../../i18n/index";
import type { ToolRegistry } from "../../tools/index";
import type { PluginManager } from "../../modules/plugins/manager";
import type { DraftHost } from "../../modules/plugins/drafts";
import type { AppConfig, ModelCapabilities } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import type { LLMProvider } from "../../llm/provider";
import type { ToolContext } from "../../tools/types";
import type { ContextProbeResult } from "../../llm/model-loader";
import { errMsg } from "../../utils";

/** Вход фазы сессий — минимум, нужный для связной группы шагов. */
export interface SessionPhaseInput {
  /** Живой конфиг. */
  config: AppConfig;
  /** Настроенный логгер. */
  logger: Logger;
  /** Каталог конфига. */
  dir: string;
  /** Workspace. */
  baseDir: string;
  /** Флаг выхода на первом ответе (прокидывается в toolCtx). */
  exitOnComplete: boolean | undefined;
  /** Явный флаг --context-log (плюс конфиг/энв внутри). */
  contextLogFlag: boolean | undefined;
  /** Фоновая context-probe (для записи итога в сессию). */
  contextProbePromise: Promise<ContextProbeResult | null>;
  /** Живой источник capabilities модели (заполняется native-probe фоном). */
  capabilitiesRef: { probe?: ModelCapabilities };
  /** Живой LLM-провайдер (для детектора галлюцинаций). */
  llmProvider: LLMProvider;
  /** Привязка ленивого session id (из фазы провайдера). */
  bindSessionManager: (getManager: () => SessionManager | undefined) => void;
  /** Реестр тулов (из фазы workspace) — для ToolExecutor. */
  toolRegistry: ToolRegistry;
  /** Менеджер плагинов (из фазы workspace) — для ToolExecutor. */
  pluginManager: PluginManager;
  /** Хост черновиков capabilities (из фазы workspace); undefined — тул недоступен. */
  draftHost?: DraftHost;
}

/** Итог фазы сессий: менеджер, контекст, живой toolCtx и окружение исполнения. */
export interface SessionPhase {
  /** Менеджер сессий (активная сессия уже создана при autoSave). */
  sessionManager: SessionManager;
  /** Хранилище сессий (путь нужен ContextLogger). */
  sessionStore: SessionStore;
  /** Git-style лог контекста (undefined при выключенном). */
  contextLogger: ContextLogger | undefined;
  /** Менеджер контекста (бюджеты под стартовое окно). */
  contextManager: ContextManager;
  /** Общий бокс ЖИВОГО конфига (reconfigure меняет ссылку для всех). */
  configRef: { current: AppConfig };
  /** Активные теги тулов (мутабельный набор, общий с enable_tools). */
  activeToolTags: string[];
  /** Общий ToolContext с живыми геттерами. */
  toolCtx: ToolContext;
  /** Исполнитель тулов (уже привязан к toolCtx). */
  toolExecutor: ToolExecutor;
  /** Детектор галлюцинаций. */
  hallucinationDetector: HallucinationDetector;
}

/**
 * Поднимает сессии, контекст и общий ToolContext.
 * @param input связный вход фазы (см. SessionPhaseInput).
 * @returns менеджер сессий, контекст, toolCtx и исполнители.
 */
export async function setupSessionPhase(input: SessionPhaseInput): Promise<SessionPhase> {
  const {
    config,
    logger,
    dir,
    baseDir,
    exitOnComplete,
    contextLogFlag,
    contextProbePromise,
    capabilitiesRef,
    llmProvider,
    bindSessionManager,
    toolRegistry,
    pluginManager,
  } = input;

  const sessionDir = join(dir, "sessions");
  const sessionStore = new SessionStore(sessionDir, config.security?.sessionEncryption);
  sessionStore.init();
  // Архивируем сессии старше 30 дней (gzip истории + метка rotated). Был мёртвый
  // код — не вызывался, старые сессии не сжимались. Отложено, чтобы синхронное
  // сжатие старт не тормозило; сбои не фатальны.
  setTimeout(() => {
    try {
      sessionStore.rotateOldSessions();
    } catch (err) {
      logger.warn(`session rotation failed: ${String(err)}`);
    }
  }, 0);
  const sessionManager = new SessionManager(sessionStore, {
    model: config.model,
    contextWindow: config.contextWindow,
    projectDir: baseDir,
    maxSessions: config.session.maxSessions,
    isolation: config.sessionIsolation,
  });
  bindSessionManager(() => sessionManager);

  if (config.session.autoSave && !sessionManager.getActive()) {
    sessionManager.create();
  }

  // Context-пробу — в сессию сразу по резолву, в ОБОИХ режимах (интерактив и
  // one-shot). Раньше писал только REPL, и one-shot терял расхождение
  // загруженного vs настроенного контекста целиком (наблюдалось: LM Studio
  // держит 86016 при contextWindow 32768 — молча).
  void contextProbePromise
    .then((probe) => {
      if (!probe) return;
      try {
        sessionManager.appendLog({
          ts: new Date().toISOString(),
          type: "context_probe",
          content: `model=${probe.model} actual=${probe.actual} configured=${config.contextWindow}`,
        });
      } catch {
        // best-effort
      }
    })
    .catch(() => {});

  // Git-style лог контекста (opt-in через --context-log / конфиг / env). Рядом
  // с файлами сессии, чтобы путешествовал с ней. Best-effort: лог не должен
  // ломать прогон никогда.
  const contextLogEnabled = contextLogFlag === true || config.contextLog?.enabled === true;
  let contextLogger: ContextLogger | undefined;
  if (contextLogEnabled) {
    const activeMeta = sessionManager.getActiveMeta();
    if (activeMeta) {
      try {
        contextLogger = new ContextLogger({
          path: join(sessionStore.getSessionDir(activeMeta.id), "context.diff"),
          sessionId: activeMeta.id,
          model: config.model,
          contextWindow: config.contextWindow,
          redact: config.contextLog?.redact !== false,
        });
      } catch (err) {
        logger.warn(t("error.context_log_init", { error: errMsg(err) }));
        contextLogger = undefined;
      }
    }
  }

  const tokenCounter = new TokenCounter(config.model);

  // Мутабельный набор активных тегов тулов — общий у цикла агента и тула
  // `enable_tools`. Цикл перечитывает его каждую итерацию для пересборки
  // видимого модели набора; enable_tools дотолкивает теги внутрь. При выключенном
  // on-demand набор пуст — легаси «все тулы» (getAllForLLM на пустых отдаёт всё).
  const enableOnDemand = config.tools?.enableOnDemand !== false;
  const activeToolTags: string[] = enableOnDemand
    ? config.tools?.defaultTags
      ? [...config.tools.defaultTags]
      : []
    : [];

  const contextManager = new ContextManager(
    config.contextWindow,
    config.contextBudget,
    tokenCounter,
  );

  // Общий бокс ЖИВОГО конфига. `Agent.reconfigure` меняет и deps.config, и
  // этот бокс, чтобы захватившие ссылку при bootstrap — toolCtx.config,
  // валидаторы, правила тулов — видели ТЕКУЩИЕ настройки после /model use или
  // визарда. Фиксация значения раз означала: тулы весь сеанс enforced
  // до-reconfigure security/maxTool.
  const configRef: { current: AppConfig } = { current: config };

  const toolCtx = {
    baseDir,
    logger,
    exitOnComplete,
    contextManager,
    activeToolTags,
    recursionDepth: 0,
    fileOperationsCount: 0,
    sessionHistory: {
      append: async (type: string, content: unknown) => {
        const meta = sessionManager.getActiveMeta();
        if (!meta) return;
        sessionManager.appendMessage({
          role: "tool",
          content: typeof content === "string" ? content : JSON.stringify(content),
          name: type,
          timestamp: new Date().toISOString(),
        });
      },
    },
    sessionLog: {
      plan: (event: string, detail: string, iteration?: number) => {
        sessionManager.appendLog({
          ts: new Date().toISOString(),
          type: "plan",
          tool: event,
          content: detail,
          ...(iteration !== undefined ? { iteration } : {}),
        });
      },
    },
  } as ToolContext;

  // `config` — ЖИВОЙ геттер поверх общего configRef: тулы и валидаторы видят
  // ТЕКУЩИЕ настройки после reconfigure.
  Object.defineProperty(toolCtx, "config", {
    get: () => configRef.current,
    configurable: true,
  });

  // `sessionId`/`sessionContext` — ЖИВЫЕ геттеры поверх менеджера сессий, а не
  // снимок при bootstrap. Снимок пинил сессию старта, и после REPL /new или
  // /resume записи audit.jsonl новой сессии тегировались id ПРЕДЫДУЩЕЙ
  // (наблюдалось: записи ses_msyghz8w с id ses_msyg892p_78kqhc), а sessionHistory
  // читал живую мету. Теперь потребители ctx.sessionId — аудит, реестр
  // процессов, счётчики файлов — всегда видят реально активную сессию.
  Object.defineProperty(toolCtx, "sessionId", {
    get: () => sessionManager.getActiveMeta()?.id,
    configurable: true,
  });
  Object.defineProperty(toolCtx, "sessionContext", {
    get: () => sessionManager.getSessionContext() ?? undefined,
    configurable: true,
  });
  Object.defineProperty(toolCtx, "sessionManager", {
    get: () => sessionManager,
    configurable: true,
  });
  // Возможности активной модели — LIVE: пресет провайдера + native-probe +
  // конфиг-оверрайд пересчитываются при каждом обращении тула, поэтому
  // инструменты (browser и т.п.) видят актуальный vision/tools после
  // смены модели или /provider use.
  Object.defineProperty(toolCtx, "capabilities", {
    get: () => {
      const cfg = configRef.current;
      const spec = BUILTIN_PROVIDERS.find((p) => p.type === cfg.provider.type);
      return resolveModelCapabilities(
        spec?.capabilities,
        capabilitiesRef.probe,
        cfg.modelCapabilities?.[cfg.model],
      );
    },
    configurable: true,
  });

  // Хост черновиков capabilities (`define_capability`). Ставится и в main, и в
  // раннеры: тул может прийти в любой вкладке веба, а черновик — проектный.
  if (input.draftHost) {
    Object.defineProperty(toolCtx, "pluginDrafts", {
      get: () => input.draftHost,
      configurable: true,
    });
  }

  const toolExecutor = new ToolExecutor(toolRegistry, toolCtx, pluginManager);
  toolCtx.llmProvider = llmProvider;
  toolCtx.toolExecutor = toolExecutor;

  const hallucinationDetector = new HallucinationDetector(baseDir, llmProvider, {
    judgeEnabled: config.hallucination?.judge?.enabled ?? false,
  });

  return {
    sessionManager,
    sessionStore,
    contextLogger,
    contextManager,
    configRef,
    activeToolTags,
    toolCtx,
    toolExecutor,
    hallucinationDetector,
  };
}
