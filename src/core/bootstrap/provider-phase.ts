/**
 * Фаза 2 bootstrap: провайдер, автозагрузка модели, пробы.
 *
 * Порядок 1:1 с исходником: эндпоинт активной записи → автозагрузка модели
 * → фоновая context-probe → профиль пользователя → сборка провайдера через
 * общую фабрику (с ленивым session id) → reasoning-стратегия + фоновая
 * reasoning-probe. Тяжёлые пробы — фоном, старт не блокируют.
 */
import { ModelLoader, probeModel, probeProviderContext } from "../../llm/model-loader";
import { join as joinDir } from "path";
import type { ContextProbeResult } from "../../llm/model-loader";
import { buildActiveProvider } from "../../modules/providers/factory";
import { activeProviderEndpoint, reasoningStrategyForProvider } from "../../modules/providers/manager";
import { syncProviderModelMemory } from "../../modules/providers/memory";
import { setProviderMemoryApplier } from "../../config/registry";
/** Эндпоинт активной записи (резолв из entries, фолбэк — легаси-плоские поля). */
export type ProbeEndpoint = ReturnType<typeof activeProviderEndpoint>;
import type { ProviderManager } from "../../modules/providers/manager";
import type { LLMProvider } from "../../llm/provider";
import { UserProfile } from "../../modules/user-profile/profile";
import { t } from "../../i18n/index";
import type { AppConfig, ModelCapabilities, ReasoningStrategy } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import type { SessionManager } from "../../modules/session/index";
import type { SilentLogger } from "./state";

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
  agent: Pick<{ currentIteration: number; reconfigure(cfg: AppConfig): Promise<void> }, "currentIteration" | "reconfigure">,
  config: AppConfig,
  probe: ContextProbeResult,
  logger: SilentLogger,
  sessionManager?: { setEffectiveContext(contextWindow: number, model?: string): void },
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
    // Мета сессии фиксирует окно из `SessionManager.create()` (стартовое
    // значение, ДО пробы). Наблюдалось: проба авто-подставила 262144 в живой
    // конфиг, а `session_start` и `meta.json` продолжали показывать 65536 —
    // расхождение не диагностировалось нигде. Синхронизируем явно (идемпотентно)
    // и проверяем результат.
    sessionManager?.setEffectiveContext(config.contextWindow, config.model);
    logger.logSilent(
      "info",
      `Context probe: applied provider context ${probe.actual} tokens (model "${probe.model}")`,
    );
    return true;
  } catch (e) {
    // INV-15: не удалось применить пробу контекста — конфиг и лог сессии
    // разойдутся, если это не записать.
    logger.logSilent(
      "warn",
      `Context probe apply FAILED: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/** Итог фазы провайдера: эндпоинт, пробы, профиль, менеджер и живой LLM-провайдер. */
export interface ProviderPhase {
  /** Эндпоинт АКТИВНОЙ записи (не легаси-плоские поля). */
  probeEndpoint: ProbeEndpoint;
  /** Загруженный и сохранённый профиль пользователя (для systemInfo). */
  profile: UserProfile;
  /** Живой источник capabilities модели для тулов (заполняется native-probe фоном). */
  capabilitiesRef: { probe?: ModelCapabilities };
  /** Значение contextWindow на старте (для детекта ручного переопределения). */
  probeConfiguredAtStart: number;
  /** Фоновая проба реально отдаваемого контекста (null = fail-open). */
  contextProbePromise: Promise<ContextProbeResult | null>;
  /** Менеджер провайдеров (hot-swap через activeName). */
  providerManager: ProviderManager;
  /** Живой LLM-провайдер (возможно failover-обёртка). */
  llmProvider: LLMProvider;
  /** Стратегия reasoning из пресета провайдера. */
  reasoningStrategy: ReasoningStrategy;
  /** Фоновая reasoning-probe (до резолва — «не пройдено»). */
  reasoningProbePromise: Promise<boolean>;
  /**
   * Привязывает ленивый session id к менеджеру сессий (создаётся позже):
   * провайдеры читают ТЕКУЩУЮ сессию в момент запроса.
   */
  bindSessionManager: (getManager: () => SessionManager | undefined) => void;
}

/**
 * Собирает провайдер и запускает фоновые пробы.
 * @param config живой конфиг; @param logger настроенный логгер; @param dir каталог конфига (для профиля).
 * @returns эндпоинт, пробы, профиль, менеджер, провайдер и биндер сессий.
 */
export async function setupProviderPhase(
  config: AppConfig,
  logger: Logger,
  dir: string,
): Promise<ProviderPhase> {
  // Память моделей провайдера — домен провайдеров (INV-19): слой конфига лишь
  // вызывает зарегистрированный апплер. Ставим один раз на bootstrap.
  setProviderMemoryApplier(syncProviderModelMemory);

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
      } else if (config.contextAuto === false) {
        // Ручной режим (`contextAuto: false`): проба не перетирает выбор юзера —
        // иначе `/context 32K` на модели с 128K молча возвращал бы 128K.
        logger.logSilent(
          "debug",
          `Context probe: contextAuto is off, keeping the configured contextWindow ${config.contextWindow} (model "${detected.model}" serves ${detected.actual})`,
        );
      } else {
        logger.logSilent(
          "info",
          `Context probe: auto-set contextWindow from provider — model "${detected.model}" serves ${detected.actual} tokens (configured was ${config.contextWindow}).`,
        );
        config.contextWindow = detected.actual;
      }
      return detected;
    } catch (e) {
      // INV-15: контекстная проба упала — это не «контекст неизвестен», а
      // «не смогли проверить»; без записи оба выглядят одинаково.
      logger.logSilent(
        "warn",
        `Context probe FAILED: ${e instanceof Error ? e.message : String(e)} — keeping the configured contextWindow`,
      );
      return null;
    }
  })();

  // Профиль пользователя — грузим здесь же, как в исходнике (до сборки
  // провайдера): load/collect/save без логгера, порядок важен для
  // systemInfo-блока фазы workspace (профиль передаётся дальше).
  const profile = new UserProfile(joinDir(dir));
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
  let sessionSource: (() => SessionManager | undefined) | undefined;
  const getSessionId = (): string | undefined => sessionSource?.()?.getActiveMeta()?.id;
  const builtProvider = buildActiveProvider(config, logger, {
    getSessionId,
    probeCapabilities: () => capabilitiesRef.probe,
  });
  const providerManager = builtProvider.manager;
  const llmProvider = builtProvider.provider;

  // Стратегия reasoning АКТИВНОЙ записи (легаси-плоское `type` протухает после
  // `/provider use` и давало чужую стратегию — напр. prompt-tag при opencode-go).
  const modelOverride = config.modelCapabilities?.[config.model];
  const reasoningStrategy = reasoningStrategyForProvider(config.provider, capabilitiesRef.probe, modelOverride);

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
          await import("../../modules/reasoning/probe");
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
      } catch (e) {
        // INV-15: проба упала — это не «reasoning не поддерживается», а
        // «не смогли проверить». Молчаливый `false` здесь означал бы то же
        // самое, что и реальный отрицательный ответ пробы.
        logger.logSilent(
          "warn",
          t("env.reasoning_probe_failed", {
            strategy: reasoningStrategy,
            error: e instanceof Error ? e.message : String(e),
          }),
        );
        return false;
      }
    })();
  }

  return {
    probeEndpoint,
    profile,
    capabilitiesRef,
    probeConfiguredAtStart,
    contextProbePromise,
    providerManager,
    llmProvider,
    reasoningStrategy,
    reasoningProbePromise,
    bindSessionManager: (getManager) => {
      sessionSource = getManager;
    },
  };
}
