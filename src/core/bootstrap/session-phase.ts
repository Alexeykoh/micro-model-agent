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
import { createContextManager } from "./context-factory";
import type { ContextManager } from "../../core/context/manager";
import { ToolExecutor } from "../../tools/executor";
import { HallucinationDetector } from "../../core/hallucination/detector";
import { createToolContext, admissionDiagnosticSink } from "./tool-context";
import { SessionStore, SessionManager } from "../../modules/session/index";
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
          source: "core",
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

  const contextManager = createContextManager(config, baseDir, sessionManager);

  // Общий бокс ЖИВОГО конфига. `Agent.reconfigure` меняет и deps.config, и
  // этот бокс, чтобы захватившие ссылку при bootstrap — toolCtx.config,
  // валидаторы, правила тулов — видели ТЕКУЩИЕ настройки после /model use или
  // визарда. Фиксация значения раз означала: тулы весь сеанс enforced
  // до-reconfigure security/maxTool.
  const configRef: { current: AppConfig } = { current: config };

  const toolCtx = createToolContext({
    baseDir,
    logger,
    exitOnComplete,
    contextManager,
    activeToolTags,
    sessionManager,
    configRef,
    capabilitiesRef,
    draftHost: input.draftHost,
  });

  const toolExecutor = new ToolExecutor(toolRegistry, toolCtx, pluginManager);
  // INV-15: fail-open admission (спилл упал → результат не admitted) пишет
  // `admission_degraded` в сессию этим же путём, что `verify_error`.
  toolExecutor.setDiagnosticSink(admissionDiagnosticSink(sessionManager));
  toolCtx.llmProvider = llmProvider;
  toolCtx.toolExecutor = toolExecutor;

  const hallucinationDetector = new HallucinationDetector(baseDir, llmProvider, {
    judgeEnabled: config.hallucination?.judge?.enabled ?? false,
    // INV-15: деградация судьи (`pass` вместо вердикта) обязана быть видна в
    // сессии, иначе «судья молчала» и «противоречий нет» неразличимы.
    onDiagnostic: admissionDiagnosticSink(sessionManager, "hallucination_judge_degraded"),
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
