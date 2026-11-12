/**
 * Фаза провайдера/конфига агента (`TurnCoordinator`, INV-23): применение нового
 * конфига живьём, context-probe активной записи, стратегия reasoning, hot-swap
 * провайдера и его листинг. Вынесено из `core/agent.ts`, чтобы класс-координатор
 * не держал провайдерную механику.
 *
 * Функции работают над `ProviderPhaseHost` — узким видом `Agent`, владеющего
 * мутабельными `deps`/`costTracker`/`lastProbeIdentity`/`probePassed`.
 */
import type { AppConfig, ProviderEntry, ReasoningStrategy } from "../../config/types";
import type { AgentDeps } from "../agent";
import type { CostTracker } from "../../modules/pricing/index";
import type { Logger } from "../../logger/app-logger";
import type { ContextProbeResult } from "../../llm/provider-context";
import {
  ProviderManager,
  activeProviderEndpoint,
} from "../../modules/providers/manager";
import { reasoningCapsForProvider } from "../../modules/providers/reasoning-resolve";
import { rememberReasoningMechanism } from "../../modules/reasoning/probe";
import { buildActiveProvider } from "../../modules/providers/factory";
import { refreshSystemInfoBlock } from "../system-prompt";
import { t } from "../../i18n/index";
import { errMsg } from "../../utils/error";
import {
  probeIdentityOf,
  sameProbeIdentity,
  refreshCapabilitiesProbe,
  restartReasoningProbe,
  invalidateReasoningProbe,
  publishContextProbe,
  type ProbeIdentity,
} from "./provider-probes";

// Реэкспорт: старый импорт-путь (`agent-base`) сохранён.
export { probeIdentityOf } from "./provider-probes";
export type { ProbeIdentity } from "./provider-probes";

/** Ключ кеша измеренного окна: `baseUrl + model + type` (INV-W6). */
function probeCacheKey(id: ProbeIdentity): string {
  return `${id.baseUrl}|${id.model}|${id.type ?? ""}`;
}

/** Опции применения нового конфига. */
export interface ReconfigureOptions {
  /**
   * false — пропустить context-probe (INV-W6: проба один раз на операцию,
   * не на раннер; кешированные раннеры пула идут с `probe: false`).
   */
  probe?: boolean;
}

/** Мутабельный вид `Agent`, которым владеет провайдерная фаза. */
export interface ProviderPhaseHost {
  deps: AgentDeps;
  costTracker: CostTracker;
  lastProbeIdentity: ProbeIdentity;
  probePassed: boolean;
  /** Кеш «идентичность → измеренное окно контекста» (INV-W6): повторное
   *  переключение на ту же идентичность сети не касается. */
  probeWindowCache: Map<string, ContextProbeResult>;
}

/** Логгер хоста (у `AgentDeps.logger` есть `.warn`/`.info`). */
function loggerOf(host: ProviderPhaseHost): Logger {
  return host.deps.logger;
}

/**
 * Применяет новый конфиг живьём: provider-first проба контекста, пересборка
 * провайдера, ресайз бюджетов, обновление стоимости.
 * @param opts `probe: false` — пропустить context-probe (см. {@link ReconfigureOptions}).
 */
export async function reconfigure(
  host: ProviderPhaseHost,
  config: AppConfig,
  opts: ReconfigureOptions = {},
): Promise<void> {
  const { deps } = host;
  // INV-R2: идентичность (model + baseUrl + active + type) — общий триггер ВСЕХ
  // провайдер-проб. `contextAuto` гейтит только контекст (в reprobe), а
  // capabilities — свойство бэкенда — перепрашиваются всегда.
  const identityChanged = !sameProbeIdentity(host.lastProbeIdentity, probeIdentityOf(config));
  if (opts.probe !== false) {
    await Promise.all([
      identityChanged ? refreshCapabilitiesProbe(host, config) : Promise.resolve(),
      reprobeActiveProvider(host, config),
    ]);
  } else if (identityChanged) {
    // Раннеры пула (`probe: false`) сеть не трогают, но применять вердикт
    // reasoning-пробы прошлой пары нельзя — сбрасываем до следующего резолва.
    invalidateReasoningProbe(host);
  }
  const built = buildActiveProvider(config, deps.logger, {
    getSessionId: () => deps.sessionManager?.getActiveMeta()?.id,
    onDiagnostic: deps.onDiagnostic,
    probeCapabilities: () => deps.capabilitiesProbeRef?.probe,
  });
  const newProvider = built.provider;
  deps.llmProvider = newProvider;
  deps.getProviderName = () => built.manager.activeName;
  deps.toolExecutor.updateProvider(newProvider);
  const { TokenCounter } = await import("../../llm/token-counter");
  const newTokenCounter = new TokenCounter(config.model);
  deps.contextManager.resize(config.contextWindow, config.contextBudget, newTokenCounter);
  deps.config = config;
  if (deps.configRef) deps.configRef.current = config;
  host.costTracker.setModel(config.model);
  // B14: живой конфиг сменился — статика системного промпта (тест-команда,
  // autoPlan, security, runtime/LSP-строки) stale с bootstrap: пересобрать.
  // Best-effort: без profileCompressed старые поверхности молча пропускают.
  refreshSystemInfoBlock(deps);
  applyReasoningStrategy(host, config.provider);
  // Новой паре — новая ленивая reasoning-проба (фон, B2): до её резолва
  // механизм «не подтверждён», а не унаследован от прошлого бэкенда.
  if (identityChanged && opts.probe !== false) {
    restartReasoningProbe(host, config, newProvider);
  }
  // Мета сессии должна отражать РЕАЛЬНОЕ окно/модель, а не снимок на create().
  deps.sessionManager?.setEffectiveContext?.(config.contextWindow, config.model);
}

/**
 * Смена окна по пробе — диагностика харнесса, а не сообщение пользователю:
 * строка «Context probe: auto-set contextWindow…» попадала в ленту обычного
 * режима (quiet). Через `diagnostic` она видна только в `verbose`.
 */
export function logContextProbeAutoSet(
  logger: Pick<Logger, "diagnostic"> | undefined,
  model: string,
  actual: number,
  configured: number,
): void {
  if (typeof logger?.diagnostic !== "function") return;
  logger.diagnostic(
    "info",
    `Context probe: auto-set contextWindow from provider — model "${model}" serves ${actual} tokens (configured was ${configured}).`,
  );
}

/**
 * Provider-first проба контекста активной записи при смене идентичности.
 * Fail-open; при `contextAuto: false` проба пропускается целиком.
 *
 * Измеренное окно кешируется по идентичности (`baseUrl + model + type`, INV-W6):
 * возврат на уже измеренную идентичность сети не касается. Кешируются только
 * успешные измерения — молчащий бэкенд остаётся пробируемым.
 */
async function reprobeActiveProvider(host: ProviderPhaseHost, config: AppConfig): Promise<void> {
  try {
    const nextId = probeIdentityOf(config);
    const prevId = host.lastProbeIdentity;
    const identityChanged =
      prevId.model !== nextId.model ||
      prevId.baseUrl !== nextId.baseUrl ||
      prevId.active !== nextId.active ||
      prevId.type !== nextId.type;
    if (!identityChanged) return;
    if (config.contextAuto === false) {
      host.lastProbeIdentity = nextId;
      publishContextProbe(host.deps.contextProbeRef, null);
      return;
    }
    const cacheKey = probeCacheKey(nextId);
    let detected: ContextProbeResult | null | undefined = host.probeWindowCache.get(cacheKey);
    if (!detected) {
      const nextEndpoint = activeProviderEndpoint(config.provider);
      const { probeProviderContext } = await import("../../llm/model-loader");
      // Один сетевой запрос: `probeProviderContext` сам спрашивает LM Studio
      // native первым источником — отдельный `probeModel` здесь дублировал его.
      detected = (await probeProviderContext(nextEndpoint.baseUrl, config.model, {
        apiKey: nextEndpoint.apiKey,
        providerType: nextEndpoint.type,
      })) ?? null;
      if (detected) host.probeWindowCache.set(cacheKey, detected);
    }
    publishContextProbe(host.deps.contextProbeRef, detected);
    if (detected && detected.actual !== config.contextWindow) {
      // Сначала применяем окно, потом пишем диагностику: сбой логгера не должен
      // отменять уже принятую пробу (в тестах и сторонних логгерах нет
      // `diagnostic`, и исключение раньше съедало присваивание).
      const configured = config.contextWindow;
      config.contextWindow = detected.actual;
      // Окно из кеша не логируем: это не новое измерение с провайдера.
      logContextProbeAutoSet(loggerOf(host), detected.model, detected.actual, configured);
    }
    host.lastProbeIdentity = nextId;
  } catch (err) {
    // Проба — best-effort, переключение модели/провайдера не блокируем никогда.
    // INV-15: «не смогли измерить» не должно выглядеть как «окно такое и есть».
    const cause = errMsg(err);
    host.deps.onDiagnostic?.({
      source: "module:providers",
      operation: "provider.context_probe",
      kind: "degraded",
      cause,
      recoverable: true,
      detail: { model: config.model },
    });
    publishContextProbe(host.deps.contextProbeRef, null);
    loggerOf(host).diagnostic(
      "warn",
      `Context probe failed for "${config.model}" — keeping configured contextWindow: ${cause}`,
    );
  }
}

/**
 * Пересчитывает стратегию reasoning из активной записи; "none" гасит probe-флаг.
 * Механизм запоминается для пары `baseUrl|model` (INV-R8): UI читает ровно тот
 * резолв, что применён к провайдеру, иначе селектор расходится с запросами.
 */
function applyReasoningStrategy(host: ProviderPhaseHost, provider: AppConfig["provider"]): void {
  const cfg = host.deps.config;
  const probe = host.deps.capabilitiesProbeRef?.probe;
  const reachable = host.deps.capabilitiesProbeRef?.reachable !== false;
  const override = cfg.modelCapabilities?.[cfg.model];
  const caps = reachable ? reasoningCapsForProvider(provider, probe, override) : {};
  const strategy: ReasoningStrategy = reachable ? caps.reasoningStrategy ?? "none" : "none";
  host.deps.reasoningStrategy = strategy;
  host.deps.reasoningLevels = reachable ? caps.reasoningLevels : undefined;
  if (strategy === "none") host.probePassed = false;
  const endpoint = activeProviderEndpoint(provider);
  rememberReasoningMechanism(endpoint.baseUrl, cfg.model, {
    strategy,
    reasoningOff: reachable && caps.reasoningOff === true,
    levels: reachable ? caps.reasoningLevels : undefined,
  });
  const ref = host.deps.capabilitiesProbeRef;
  if (ref) {
    ref.reasoningStrategy = strategy;
    ref.reasoningLevels = host.deps.reasoningLevels;
    ref.reasoningOff = reachable && caps.reasoningOff === true;
  }
}

/** Переключает активного провайдера (и модель) тем же путём, что `/config`. */
export async function setProvider(
  host: ProviderPhaseHost,
  name: string,
  model?: string,
): Promise<void> {
  const { deps } = host;
  const { manager } = buildActiveProvider(deps.config, deps.logger, {
    getSessionId: () => deps.sessionManager?.getActiveMeta()?.id,
    onDiagnostic: deps.onDiagnostic,
  });
  // Модель провайдера (память INV-19): без явного аргумента восстанавливаем
  // запомненную для записи — иначе в новый бэкенд уехала бы модель прошлого
  // (наблюалось: llama.cpp-модель в opencode-go). Ничего не запомнено —
  // сохраняем текущую, перепроба/контекст под неё и так честнее чужой.
  const target = model ?? manager.modelFor(name) ?? deps.config.model;
  manager.switch(name, target);
  deps.config.provider = manager.toConfig();
  deps.config.model = target;
  // Память — последняя использованная модель новой активной записи (зеркало
  // записи через реестр: `syncProviderModelMemory` при ключе `model`).
  deps.config.provider.models = {
    ...(deps.config.provider.models ?? {}),
    [name]: target,
  };
  await reconfigure(host, deps.config);
}

/** Список записей провайдеров с флагом активности. */
export function listProviders(
  host: ProviderPhaseHost,
): Array<ProviderEntry & { label: string; active: boolean }> {
  const { deps } = host;
  const manager = new ProviderManager(deps.config.provider, {
    contextWindow: deps.config.contextWindow,
    retry: deps.config.retry,
    rateLimits: deps.config.security?.rateLimits,
    getSessionId: () => deps.sessionManager?.getActiveMeta()?.id,
  });
  const activeName = deps.config.provider.active;
  return manager.list().map((e) => ({
    ...e,
    active: e.label === activeName || e.type === activeName,
  }));
}

/** Строит провайдер именованной записи (health-чеки, роутинг); null при ошибке. */
export function getProviderFor(
  host: ProviderPhaseHost,
  name: string,
): import("../../llm/provider").LLMProvider | undefined {
  const { deps } = host;
  try {
    const manager = new ProviderManager(deps.config.provider, {
      contextWindow: deps.config.contextWindow,
      retry: deps.config.retry,
      rateLimits: deps.config.security?.rateLimits,
      getSessionId: () => deps.sessionManager?.getActiveMeta()?.id,
      logger: deps.logger,
    });
    manager.setModel(deps.config.model);
    manager.switch(name);
    return manager.active;
  } catch (err) {
    deps.logger.warn(t("error.provider_build", { name, error: errMsg(err) }));
    return undefined;
  }
}
