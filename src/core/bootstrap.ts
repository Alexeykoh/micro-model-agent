/** Bootstrap агента: конфиг, провайдер, тулы, модули, Agent. */
import { loadConfig } from "../config/config";
import { Logger } from "../logger/app-logger";
import type { LogLevel } from "../logger/app-logger";
import { buildActiveProvider } from "../modules/providers/factory";
import { activeProviderEndpoint } from "../modules/providers/manager";
import { BUILTIN_PROVIDERS } from "../modules/providers/presets";
import { ModelLoader } from "../llm/model-loader";
import { ToolRegistry, registerAllTools } from "../tools/index";
import { buildHiddenToolsBlock } from "../tools/hidden-tools-block";
import { ToolExecutor } from "../tools/executor";
import { ModuleRegistry } from "../modules/registry";
import { PluginManager } from "../modules/plugins/manager";
import { PluginLoader } from "../modules/plugins/loader";
import { plugin as lintOnWritePlugin } from "../modules/plugins/builtin/lint-on-write";
import { plugin as notifyPlugin } from "../modules/plugins/builtin/notify";
import { ContextManager } from "../modules/context/manager";
import { TokenCounter, estimateTokens } from "../llm/token-counter";
import { HallucinationDetector } from "../modules/hallucination/detector";
import { ExecutionModule } from "../modules/execution/module";
import { SessionStore, SessionManager, SessionModule } from "../modules/session/index";
import { UserProfile } from "../modules/user-profile/profile";
import { SkillsLoader, SkillsModule } from "../modules/skills/index";
import { BrowserModule } from "../modules/browser/index";
import { LspModule, FileOnlyLogger, DEFAULT_LSP_CONFIG } from "../modules/lsp/index";
import { runStartupHealthCheck } from "../modules/lsp/startup-check";
import { IndexerModule } from "../modules/indexer/index";
import { MCPModule } from "../modules/mcp/index";
import { MemoryModule } from "../modules/memory/module";
import { MemoryStore } from "../modules/memory/store";
import { t, setLocale, setMissingKeyReporter } from "../i18n/index";
import { buildSystemInfo } from "./system-prompt";
import { Agent } from "./agent";
import { ContextLogger } from "./agent/context-log";
import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync, readFileSync, statSync, } from "fs";
import type { AgentDeps } from "./agent";
import type { ToolContext } from "../tools/types";
import type { PromptBlock } from "./types";
import type { AppConfig, ModelCapabilities } from "../config/types";
import { resolveModelCapabilities } from "../modules/providers/capabilities";
import { readMmaVersion } from "./version";
import { collectEnvironment, logEnvironment } from "./environment";
import { errMsg } from "../utils";
import { dryRunOverflow, overflowHint } from "./prompt-overflow";
import { probeModel, probeProviderContext, type ContextProbeResult } from "../llm/model-loader";
import type { AgentPlugin } from "../modules/types";
import type { ReasoningLevel } from "../config/types";
import {
  globalMmaDir,
  globalPluginsDir as resolveGlobalPluginsDir,
  projectMmaDir,
} from "../config/paths";

/**
 * CLI --reasoning переопределяет конфигурационный режим
 * (приоритет: CLI > config > default). "auto" пропускается — полагаемся
 * на конфиг. Строка CLI приводится к типизированному ReasoningLevel.
 */
export function applyReasoningCliOverride(
  config: AppConfig,
  reasoningLevel: string | undefined,
): void {
  if (!reasoningLevel || reasoningLevel === "auto") return;
  if (!config.reasoning) {
    config.reasoning = {
      mode: reasoningLevel as ReasoningLevel,
      min: "low",
      max: "high",
      overrideCooldown: 3,
    };
  } else {
    config.reasoning.mode = reasoningLevel as ReasoningLevel;
  }
}

/** Регистрация встроенного плагина модуля: пометка + регистрация. */
function registerBuiltinPlugin(pm: PluginManager, plugin: AgentPlugin | undefined): void {
  if (!plugin) return;
  plugin.isBuiltin = true;
  pm.register(plugin);
}

/**
 * Позднее применение резолвнутой context-probe. Проба приземляется фоном ПОСЛЕ
 * сборки ContextManager/провайдера под стартовое окно — одна запись значения в
 * `config` оставит бюджеты протухшими, поэтому нужен reconfigure (ресайз +
 * пересборка провайдера).
 *
 * Пропуск, когда применять нечего (`config` больше не несёт значение пробы —
 * совпало сразу или переопределено вручную) или ход уже был (ресайз посреди
 * истории ломает бюджеты). Не бросает никогда.
 */
export async function applyProbedContext(
  agent: Pick<Agent, "currentIteration" | "reconfigure">,
  config: AppConfig,
  probe: ContextProbeResult,
  logger: Pick<Logger, "logSilent">,
): Promise<boolean> {
  if (config.contextWindow !== probe.actual) return false;
  if (agent.currentIteration !== 0) {
    logger.logSilent(
      "debug",
      `Context probe: keeping startup contextWindow ${config.contextWindow} — a turn already ran`,
    );
    return false;
  }
  try {
    await agent.reconfigure(config);
    logger.logSilent(
      "info",
      `Context probe: applied provider context ${probe.actual} tokens (model "${probe.model}")`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Резолвит workspace агента. Несуществующий `-d` (классика: шелл режет по
 * пробелам, висячий бэкслэш экранирует кавычку) должен упасть ГРОМКО здесь —
 * иначе агент молча работает не в том каталоге и уверяет, что всё хорошо.
 */
export function resolveBaseDir(projectDir?: string): string {
  if (!projectDir) return process.cwd();
  const abs = resolve(projectDir);
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new Error(
      `workspace directory does not exist: ${abs} (received ${JSON.stringify(projectDir)} — ` +
        `if the path contains spaces, quote it without a trailing backslash)`,
    );
  }
  return abs;
}

/** Кандидаты AGENTS.md по приоритету: проект, проектный `.mma`, глобальный. */
export function agentsMdPaths(baseDir: string, configDir: string): string[] {
  return [join(baseDir, "AGENTS.md"), join(projectMmaDir(baseDir), "AGENTS.md"), join(configDir, "AGENTS.md")];
}

/**
 * Грузит AGENTS.md из каталога проекта и конфиг-каталога (по приоритету).
 * Каждый найденный непустой файл — prompt-блок высокого приоритета.
 * @param baseDir workspace; @param dir каталог конфига; @param skip пропустить загрузку.
 * @returns блоки инструкций для системного промпта.
 */
function loadAgentsMdBlocks(baseDir: string, dir: string, skip: boolean): PromptBlock[] {
  if (skip) return [];
  const blocks: PromptBlock[] = [];
  const candidates = agentsMdPaths(baseDir, dir);
  for (const p of candidates) {
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8").trim();
      if (content) {
        blocks.push({
          content,
          priority: "high",
          essential: false,
          estimatedTokens: estimateTokens(content),
          kind: "instructions",
        });
      }
    }
  }
  return blocks;
}

/** Отклоняет `promise` через `ms`; таймер победителя снимается. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const VALID_LOG_LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

/** Нормализует строку из конфига в LogLevel (без `as any`); неизвестное → info. */
function normalizeLogLevel(value: string | undefined): LogLevel {
  return value && VALID_LOG_LEVELS.includes(value) ? (value as LogLevel) : "info";
}

export { buildSystemInfo } from "./system-prompt";

/** Итог bootstrap: агент, конфиг, логгеры, модули, пробы. */
export interface BootstrapResult {
  agent: Agent;
  config: AppConfig;
  logger: Logger;
  sessionManager: SessionManager;
  skillsModule: SkillsModule;
  pluginManager: PluginManager;
  /** Владелец состояния плана — UI (REPL) читают активный план отсюда, а не перечитывают .mma/plans/active.json. */
  execModule: ExecutionModule;
  /** Общий ToolContext; `sessionId`/`sessionContext` — живые геттеры поверх
   *  менеджера сессий, смена сессии отражается всегда. */
  toolCtx: ToolContext;
  /** Живой реестр тулов. Веб-режим дорегистрирует интерактивные тулы
   *  (question/approve) после bootstrap, не трогая терминал. */
  toolRegistry: ToolRegistry;
  configDir: string;
  baseDir: string;
  noAgentsMd: boolean;
  envReport: ReturnType<typeof collectEnvironment>;
  /** true при легаси config.json (доменных файлов нет). */
  legacyDetected: boolean;
  /** Фоновая проба длины контекста, с которой модель РЕАЛЬНО загружена
   *  (LM Studio native API). Null, если неприменимо. */
  contextProbe: Promise<ContextProbeResult | null>;
  /** Общий глобальный стор памяти — один инстанс у модуля памяти и цикла,
   *  поэтому UI (`mma web` `/memory`) читают/пишут живые данные. */
  memoryStore: MemoryStore;
  /** Индексатор карты проекта — веб-режим показывает статистику в панели окружения. */
  indexerModule: IndexerModule;
}

/**
 * One-shot CLI-подкоманды (`session show`, `usage`, `config` …) рисуют итог и
 * выходят. Фоновый стартовый health-check спавнит дочерний процесс (LSP/tsc),
 * который `process.exit` не пожинает — на Windows сирота держит stdout-пайп, и
 * пайп команды (`mma session show <id> | cat`) виснет. Подкоманды агента не
 * гоняют, поэтому чек там пропускается.
 */
let oneShotMode = false;
/**
 * Включает one-shot режим (пропуск фонового health-check для подкоманд).
 * @param value true — подкоманда без агента.
 */
export function setOneShotMode(value: boolean): void {
  oneShotMode = value;
}

/**
 * Собирает всё для работы агента: конфиг, окружение, провайдер, пробы,
 * тулы, модули, Agent. Тяжёлые старты (health-check, пробы) — фоном.
 * @param configDir каталог конфига; @param projectDir workspace;
 * @param noAgentsMd пропустить AGENTS.md; @param exitOnComplete стоп на первом ответе;
 * @param reasoningLevel CLI-override reasoning; @param contextLog git-лог контекста.
 * @returns агент и окружение.
 */
export async function bootstrap(
  configDir?: string,
  projectDir?: string,
  noAgentsMd?: boolean,
  exitOnComplete?: boolean,
  reasoningLevel?: string,
  contextLog?: boolean,
): Promise<BootstrapResult> {
  const dir = configDir || globalMmaDir();
  const projectConfigPath = projectDir ? join(projectDir, ".mmrc") : join(process.cwd(), ".mmrc");

  const { config, legacyDetected } = loadConfig({ configDir: dir, projectConfigPath });
  setLocale(config.locale);

  // CLI --reasoning перебивает режим конфига (приоритет: CLI > config > default)
  applyReasoningCliOverride(config, reasoningLevel);

  // Глобальный audit-нотифаер — по конфигу
  let auditNotifyError: string | undefined;
  try {
    const { globalAuditNotifier } = await import("../modules/security/audit-notifier");
    if (config.security?.auditNotifier) {
      globalAuditNotifier.updateConfig(
        config.security.auditNotifier as Partial<typeof config.security.auditNotifier>,
      );
    }
  } catch (err) {
    // Logger ещё не создан — запомним и залогируем после его инициализации.
    auditNotifyError = errMsg(err);
  }

  const logger = new Logger(normalizeLogLevel(config.logLevel));
  logger.setLogDir(join(dir, "logs"));
  // Диагностика опечаток в ключах i18n — видна только на debug-уровне.
  setMissingKeyReporter((key) => logger.debug(`Missing i18n key: ${key}`));
  if (auditNotifyError) {
    logger.debug(`Audit notifier config skipped: ${auditNotifyError}`);
  }
  logger.debug("MMA bootstrap", {
    version: config.version,
    model: config.model,
  });

  // Синхронизируем бандл-манифест версии пакета в ~/.mma/certifications.json
  // (бандл-записи затирают свои ключи при апдейте; пользовательские сохраняются).
  // Best-effort, молча.
  try {
    const { syncGlobalManifest } = await import("../modules/certification/manifest");
    const syncResult = syncGlobalManifest();
    if (syncResult.synced) {
      logger.debug("Certification manifest synced from package");
    }
  } catch {
    // Метки сертификации косметические — старт не блокируем никогда.
  }

  // Эндпоинт для пробы/автозагрузки: АКТИВНАЯ запись, не легаси-плоские поля
  // (они зеркалят активное на момент последней записи и протухают после
  // `/provider use` — наблюдалось: плоский localhost:1234 при активной записи
  // opencode-go, и Zen вообще не опрашивался).
  const probeEndpoint = activeProviderEndpoint(config.provider);

  if (config.modelLoad.autoLoad) {
    const modelLoader = new ModelLoader(probeEndpoint.baseUrl, logger);
    const loadResult = await modelLoader.ensureModelLoaded({
      model: config.model,
      contextLength: config.contextWindow,
      flashAttention: config.modelLoad.flashAttention,
      offloadKvCacheToGpu: config.modelLoad.offloadKvCacheToGpu,
      autoLoad: config.modelLoad.autoLoad,
    });

    if (!loadResult.success) {
      logger.warn(t("env.model_autoload_failed", { error: String(loadResult.error ?? "") }));
    } else if (loadResult.alreadyLoaded) {
      logger.debug(`Model ${config.model} already loaded`);
    } else {
      logger.info(
        t("env.model_loaded", { model: config.model, seconds: String(loadResult.loadTime) }),
      );
    }
  }

  // Context-проба (фоном): спрашиваем АКТИВНЫЙ провайдер о длине контекста,
  // что РЕАЛЬНО отдаётся модели (загруженный инстанс, не максимум карточки),
  // и берём как эффективный contextWindow — провайдер бьёт конфиг. Баннер не
  // блокирует никогда; null = окно никто не сообщил (голый OpenAI-compat
  // `/models`, офлайн, транзиентка) — храним настроенный (fail-open). Ручной
  // `mma context <N>` / `/config contextWindow <N>` после — действует до конца сессии.
  // Живой источник возможностей модели для тулов (browser vision и т.п.).
  // Пресет и конфиг-оверрайд известны сразу, native-probe уточняет их
  // асинхронно и записывает сюда, не блокируя старт. Геттер на toolCtx
  // резолвит итог при каждом обращении, поэтому смена модели/провайдера
  // через reconfigure видна тулам без пересборки контекста.
  const capabilitiesRef: { probe?: ModelCapabilities } = {};

  // Значение на старте. Проба резолвится фоном — если пользователь успел
  // сменить contextWindow раньше (веб-UI до приземления пробы), побеждает его
  // явный выбор, а итог пробы только логируется.
  const probeConfiguredAtStart = config.contextWindow;

  const contextProbePromise: Promise<ContextProbeResult | null> = (async () => {
    try {
      const lmProbe = await probeModel(probeEndpoint.baseUrl, config.model);
      if (lmProbe?.capabilities) capabilitiesRef.probe = lmProbe.capabilities;
      const lmContext = lmProbe ? { model: lmProbe.model, actual: lmProbe.contextLength } : null;
      const detected =
        lmContext ??
        (await probeProviderContext(probeEndpoint.baseUrl, config.model, {
          apiKey: probeEndpoint.apiKey,
          providerType: probeEndpoint.type,
        }));
      if (!detected) return null;
      if (detected.actual === config.contextWindow) {
        logger.logSilent(
          "debug",
          `Context probe: configured contextWindow matches provider context (${detected.actual})`,
        );
      } else if (config.contextWindow !== probeConfiguredAtStart) {
        logger.logSilent(
          "debug",
          `Context probe: model "${detected.model}" serves ${detected.actual} tokens, keeping the explicit contextWindow ${config.contextWindow}`,
        );
      } else {
        logger.logSilent(
          "info",
          `Context probe: auto-set contextWindow from provider — model "${detected.model}" serves ${detected.actual} tokens (configured was ${config.contextWindow}).`,
        );
        config.contextWindow = detected.actual;
      }
      return detected;
    } catch {
      return null;
    }
  })();

  const profile = new UserProfile(join(dir));
  profile.load() || profile.collect();
  profile.save();

  // Мультипровайдерный менеджер (Phase 2) + опциональная прозрачная failover-
  // обёртка (Phase 4.2). Строится через общую фабрику, чтобы hot-swap через
  // Agent.setProvider получал ТО ЖЕ fallback-поведение, что старт, а не голый
  // менеджер, молча роняющий failover (B4).
  //
  // Session id резолвится лениво: менеджер сессий создаётся ниже, а провайдеры
  // должны читать ТЕКУЩУЮ сессию в момент запроса (hot-swap, смена сессии).
  // OpenCode Go режектит запросы без `x-opencode-session`.
  let activeSessionManager: SessionManager | undefined;
  const getSessionId = (): string | undefined => activeSessionManager?.getActiveMeta()?.id;
  const builtProvider = buildActiveProvider(config, logger, { getSessionId });
  const providerManager = builtProvider.manager;
  const llmProvider = builtProvider.provider;

  // Стратегия reasoning из пресета провайдера + пробы
  const providerSpec = BUILTIN_PROVIDERS.find((p) => p.type === config.provider.type);
  const reasoningStrategy = providerSpec?.capabilities.reasoningStrategy ?? "none";

  // Reasoning-проба — ФОНОМ (B2). Раньше блокировала bootstrap лишним LLM
  // round-trip на каждый запуск; теперь агент потребляет её лениво перед первым
  // LLM-вызовом (тот же паттерн, что стартовый health-check), а до резолва
  // механизм считается НЕ прошедшим. 24h TTL диск-кэша в probe.ts и так
  // бережёт стабильный бэкенд от перепроверок.
  let reasoningProbePromise: Promise<boolean> = Promise.resolve(false);
  if (config.reasoning && config.reasoning.mode !== "none" && reasoningStrategy !== "none") {
    reasoningProbePromise = (async () => {
      try {
        const { probeReasoningSupport, getCachedProbeResult, setCachedProbeResult } =
          await import("../modules/reasoning/probe");
        const cacheK = `${probeEndpoint.baseUrl ?? ""}|${config.model}`;
        const cached = getCachedProbeResult(cacheK);
        const passed =
          cached !== undefined
            ? cached
            : await probeReasoningSupport(llmProvider, reasoningStrategy);
        // Кэшируем только определённый итог — транзиентная ошибка пробы (null)
        // НЕ должна пинить «reasoning не поддерживается» на 24h TTL.
        if (cached === undefined && passed !== null) setCachedProbeResult(cacheK, passed);
        logger.logSilent(
          "info",
          t("env.reasoning_probe", {
            strategy: reasoningStrategy,
            result: passed === true ? t("env.reasoning_respected") : t("env.reasoning_ignored"),
          }),
        );
        // null (транзиентка) — фолбэк «не пройдено» на эту сессию.
        return passed === true;
      } catch {
        return false;
      }
    })();
  }

  const baseDir = resolveBaseDir(projectDir);

  // Кросс-девайс диагностика: полный отчёт окружения (ОС, рантайм, engines,
  // PATH-тулы, провайдер/ретраи, playwright) на каждый старт.
  const envReport = collectEnvironment({
    configDir: dir,
    baseDir,
    config,
    scanTools: process.env.NODE_ENV !== "test",
  });
  logEnvironment(envReport, logger);
  for (const warning of envReport.warnings) {
    logger.warn(warning);
  }

  const projectMapCacheDir = projectMmaDir(baseDir);
  const indexerModule = new IndexerModule({
    baseDir,
    cacheDir: projectMapCacheDir,
  });
  try {
    // Строим (или грузим из кэша) индекс проекта. На большом workspace первый
    // обход подвисает старт без вывода — анонсируем оба конца, чтобы тишина
    // была объяснена.
    logger.info(t("env.indexing"));
    const index = await indexerModule.buildIndex();
    if (index) {
      logger.info(t("env.indexed", { files: String(index.files.length) }));
    } else {
      logger.warn(t("env.indexing_failed", { error: "no index produced" }));
    }
  } catch (err: any) {
    logger.warn(t("env.indexing_failed", { error: String(err?.message ?? err) }));
  }

  const skillsLoader = new SkillsLoader();
  const builtinDir = join(import.meta.dirname, "skills", "builtin");
  const globalDir = join(homedir(), ".agents", "skills");
  const projectSkillsDir = join(projectMmaDir(baseDir), "skills");
  const availableSkills = skillsLoader.loadFromAllSources(builtinDir, globalDir, projectSkillsDir);

  const skillsBudget = Math.floor(config.contextWindow * config.skills.budget);
  const skillsModule = new SkillsModule(availableSkills, skillsBudget);

  const toolRegistry = new ToolRegistry();
  registerAllTools(toolRegistry, skillsModule, {
    enableOnDemand: config.tools?.enableOnDemand,
  });

  const pluginManager = new PluginManager();

  const systemInfoContent = buildSystemInfo(config, baseDir, profile.compress());
  const systemInfoPrompt: PromptBlock = {
    content: systemInfoContent,
    priority: "critical",
    essential: true,
    estimatedTokens: estimateTokens(systemInfoContent),
  };

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
  activeSessionManager = sessionManager;

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
  const contextLogEnabled = contextLog === true || config.contextLog?.enabled === true;
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

  const toolExecutor = new ToolExecutor(toolRegistry, toolCtx, pluginManager);
  toolCtx.llmProvider = llmProvider;
  toolCtx.toolExecutor = toolExecutor;

  const hallucinationDetector = new HallucinationDetector(baseDir, llmProvider, {
    judgeEnabled: config.hallucination?.judge?.enabled ?? false,
  });

  const moduleRegistry = new ModuleRegistry();

  const execModule = new ExecutionModule(
    baseDir,
    config.stuckThreshold,
    config.errorWebSearch?.threshold ?? 5,
  );
  // План в .mma/plans/active.json — состояние ПРОЕКТА, не сессии: восстанавливаем
  // в каждой сессии, чтобы `plan show` работал и чеклист был виден. Без спроса
  // не печатаем ничего: REPL рисует чеклист только на plan/todo-событиях.
  execModule.restorePlan();
  moduleRegistry.register(execModule);
  execModule.setHallucinationDetector(hallucinationDetector);

  const sessionModule = new SessionModule(sessionManager);
  moduleRegistry.register(sessionModule);

  moduleRegistry.register(indexerModule);

  const mcpModule = new MCPModule(config);
  try {
    // Ограничиваем init MCP, чтобы один медленный/висящий сервер не стопил boot
    // навсегда (B5): на таймауте — лог-и-дальше, MCP-тулы появятся поздно или
    // не появятся, вместо stall'а старта.
    await withTimeout(mcpModule.initialize(), 10_000);
  } catch (err) {
    logger.warn(
      `MCP init failed or timed out (${err instanceof Error ? err.message.slice(0, 120) : String(err)}) — continuing without MCP tools.`,
    );
  }
  moduleRegistry.register(mcpModule);

  const memoryStore = new MemoryStore(join(dir, "memory"));
  const memoryModule = new MemoryModule(memoryStore);
  moduleRegistry.register(memoryModule);

  if (config.browser.enabled) {
    const browserModule = new BrowserModule();
    moduleRegistry.register(browserModule);
    registerBuiltinPlugin(pluginManager, browserModule.getPlugin());
  }

  const lspLogger = new FileOnlyLogger(logger);
  const lspModule = new LspModule(config.lsp, undefined, lspLogger);
  moduleRegistry.register(lspModule);
  registerBuiltinPlugin(pluginManager, lspModule.getPlugin());

  // Стартовый health-check: сканируем проект на существующие ошибки, чтобы модель
  // знала baseline до работы. Пропуск для one-shot и тестов. Старт фоном (без
  // await), чтобы баннер REPL не ждал `npx tsc` по проекту; Agent дожидается
  // через `lazyPromptBlocks` перед первым LLM-вызовом (к вводу пользователя
  // в интерактиве уже резолвнут).
  let startupCheckBlock: PromptBlock | null = null;
  const startupCheckPromise =
    !oneShotMode && !exitOnComplete && process.env.NODE_ENV !== "test"
      ? runStartupHealthCheck(config.lsp ?? DEFAULT_LSP_CONFIG, baseDir, { logger: lspLogger })
      : Promise.resolve(null);

  const moduleTools = moduleRegistry.collectToolDefinitions();
  for (const tool of moduleTools) {
    toolRegistry.register(tool);
  }

  const plugin = execModule.getPlugin();
  registerBuiltinPlugin(pluginManager, plugin);

  registerBuiltinPlugin(pluginManager, sessionModule.getPlugin());

  registerBuiltinPlugin(pluginManager, skillsModule.getPlugin());

  registerBuiltinPlugin(pluginManager, indexerModule.getPlugin());

  registerBuiltinPlugin(pluginManager, mcpModule.getPlugin());

  pluginManager.register(lintOnWritePlugin);
  pluginManager.register(notifyPlugin);

  const pluginLoader = new PluginLoader();
  const globalPluginsDir = resolveGlobalPluginsDir();
  const projectPluginsDir = join(projectMmaDir(baseDir), "plugins");
  const mmaVersion = readMmaVersion();
  pluginLoader.loadFromDir(globalPluginsDir, pluginManager, logger, {
    source: "global",
    mmaVersion,
  });
  pluginLoader.loadFromDir(projectPluginsDir, pluginManager, logger, {
    source: "project",
    mmaVersion,
  });

  contextManager.onCompact = (summary) => {
    const meta = sessionManager.getActiveMeta();
    if (!meta || !config.session.autoSave) return;
    sessionManager.appendMessage({
      role: summary.role,
      content: summary.content,
      name: summary.name,
      timestamp: new Date().toISOString(),
    });
  };

  // Активный план (id, прогресс, текущий шаг) — в сводку компакции, чтобы 9B
  // модель не пересоздавала план с нуля сразу после неё (наблюдалось:
  // ses_msvuao0h — plan_e07pb2 (1/6) выкинут ради свежего plan_xzq9xe той же
  // итерацией, где старый план ещё был виден).
  contextManager.setPlanSummaryProvider(() => execModule.getPlanSummary());

  const agentsMdBlocks = loadAgentsMdBlocks(baseDir, dir, noAgentsMd === true);

  const promptBlocks: PromptBlock[] = [
    systemInfoPrompt,
    ...moduleRegistry.collectPromptBlocks(["indexer", "session"]),
    ...agentsMdBlocks,
    // Статичное напоминание о плане: всегда в наличии, чтобы модель проверяла
    // активный план до создания нового (даже на первой итерации, до появления
    // <system-summary>).
    {
      content:
        "[Plan Reminder] An active plan may exist for this session. Before creating a new plan, check with `plan show`. If a plan is active, continue it — do NOT create a new plan.",
      priority: "high",
      essential: false,
      estimatedTokens: 50,
    },
  ];

  // Стартовый варнинг переполнения (баннер, A3): dry-run бюджета системного
  // промпта тем же набором блоков, что возьмёт первая сборка Agent (статика +
  // скиллы + карта + скрытые тулы), наружу — невместившиеся instructions/
  // project-map. Agent сожмёт их перед первым LLM-вызовом; варнинг говорит
  // ПОЛЬЗОВАТЕЛЮ почему и как вернуть полный текст.
  {
    const dynamicBlocks: PromptBlock[] = [];
    const skillsBlock = skillsModule.getSystemPromptBlock();
    if (skillsBlock) dynamicBlocks.push(skillsBlock);
    const mapBlock = indexerModule.getSystemPromptBlock();
    if (mapBlock) dynamicBlocks.push(mapBlock);
    const hiddenToolsBlock = buildHiddenToolsBlock(toolRegistry.getAll(), activeToolTags);
    if (hiddenToolsBlock) {
      dynamicBlocks.push({
        content: hiddenToolsBlock,
        priority: "low",
        essential: false,
        estimatedTokens: estimateTokens(hiddenToolsBlock),
      });
    }
    const systemBudget = Math.floor(config.contextWindow * config.contextBudget.systemPrompt);
    const dry = dryRunOverflow([...promptBlocks, ...dynamicBlocks], systemBudget);
    if (dry.overflow.length > 0) {
      const overflowTokens = dry.overflow.reduce((s, b) => s + b.estimatedTokens, 0);
      const needed = dry.includedTokens + overflowTokens;
      const hint = overflowHint(config, dir, needed);
      for (const b of dry.overflow) {
        logger.warn(
          t("prompt.overflow.startup", {
            block: b.kind === "instructions" ? "AGENTS.md" : "project map",
            original: String(b.estimatedTokens),
            needed: String(needed),
            budget: String(systemBudget),
            hint,
          }),
        );
      }
    }
  }

  const agentDeps: AgentDeps = {
    config,
    configRef,
    llmProvider,
    getProviderName: () => providerManager.activeName,
    toolExecutor,
    pluginManager,
    contextManager,
    hallucinationDetector,
    logger,
    baseDir,
    configDir: dir,
    toolTags: activeToolTags,
    promptBlocks,
    envReport,
    getDynamicPromptBlocks: () => {
      const blocks: PromptBlock[] = [];
      // План-блок удалён: мутирует каждую итерацию (статусы шагов), инвалидируя
      // локальный KV-кеш. Статус плана теперь инжектится в <system-summary>
      // после каждого пакета тулов.
      const skillsBlock = skillsModule.getSystemPromptBlock();
      if (skillsBlock) blocks.push(skillsBlock);
      // Мета сессии (id/имя/модель/контекст) собирается здесь, а не при
      // bootstrap: сессия создаётся при bootstrap с messageCount 0, и статичный
      // сбор всегда давал бы null. Контент стабилен на сессию (без per-turn
      // полей) ради prefix KV-кеша.
      const sessionBlock = sessionModule.getSystemPromptBlock();
      if (sessionBlock) blocks.push(sessionBlock);
      const mapBlock = indexerModule.getSystemPromptBlock();
      if (mapBlock) blocks.push(mapBlock);
      const hiddenToolsBlock = toolCtx.toolAllowlist
        ? null
        : buildHiddenToolsBlock(toolRegistry.getAll(), activeToolTags);
      if (hiddenToolsBlock) {
        blocks.push({
          content: hiddenToolsBlock,
          priority: "low",
          essential: false,
          estimatedTokens: estimateTokens(hiddenToolsBlock),
        });
      }
      return blocks;
    },
    finalAudit: () => execModule.runFinalAudit(),
    lazyPromptBlocks: async () => {
      if (startupCheckBlock) return [startupCheckBlock];
      startupCheckBlock = (await startupCheckPromise) ?? null;
      return startupCheckBlock ? [startupCheckBlock] : [];
    },
    sessionManager,
    memoryStore,
    moduleRegistry,
    exitOnComplete,
    contextLogger,
    reasoningProbe: () => reasoningProbePromise,
    reasoningStrategy,
    planSummary: () => execModule.getPlanSummary(),
    toolCtx,
  };

  const agent = new Agent(agentDeps);

  // Поздний резолв пробы: окно могло попасть в `config` после сборки
  // ContextManager/провайдера — один reconfigure, чтобы бюджеты и провайдер
  // его реально использовали. No-op, если проба села рано (то же значение)
  // или ход уже был.
  void contextProbePromise
    .then((probe) => {
      if (!probe) return;
      return applyProbedContext(agent, config, probe, logger);
    })
    .catch(() => {});

  // Тул set_thinking (нужен общее reasoning-состояние агента)
  if (config.reasoning) {
    const { createSetThinkingTool } = await import("../tools/set-thinking");
    const setThinkingTool = createSetThinkingTool(
      agent.reasoningState,
      config.reasoning,
      () => agent.currentIteration,
    );
    toolRegistry.register(setThinkingTool);
  }

  return {
    agent,
    config,
    logger,
    sessionManager,
    skillsModule,
    pluginManager,
    execModule,
    toolCtx,
    toolRegistry,
    configDir: dir,
    baseDir,
    noAgentsMd: noAgentsMd === true,
    envReport,
    legacyDetected,
    contextProbe: contextProbePromise,
    memoryStore,
    indexerModule,
  };
}
