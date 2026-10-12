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
import { ProviderManager, activeProviderEndpoint, reasoningStrategyForProvider } from "../../modules/providers/manager";
import { buildActiveProvider } from "../../modules/providers/factory";
import { t } from "../../i18n/index";
import { errMsg } from "../../utils/error";

/** Идентичность модели/бэкенда, против которой гонялась context-probe. */
export interface ProbeIdentity {
  model: string;
  baseUrl: string;
  active?: string;
}

/** Снимок идентичности активной записи (сравнение по значению, не по ссылке). */
export function probeIdentityOf(config: AppConfig): ProbeIdentity {
  return {
    model: config.model,
    baseUrl: activeProviderEndpoint(config.provider).baseUrl,
    active: config.provider?.active,
  };
}

/** Мутабельный вид `Agent`, которым владеет провайдерная фаза. */
export interface ProviderPhaseHost {
  deps: AgentDeps;
  costTracker: CostTracker;
  lastProbeIdentity: ProbeIdentity;
  probePassed: boolean;
}

/** Логгер хоста (у `AgentDeps.logger` есть `.warn`/`.info`). */
function loggerOf(host: ProviderPhaseHost): Logger {
  return host.deps.logger;
}

/**
 * Применяет новый конфиг живьём: provider-first проба контекста, пересборка
 * провайдера, ресайз бюджетов, обновление стоимости.
 */
export async function reconfigure(host: ProviderPhaseHost, config: AppConfig): Promise<void> {
  const { deps } = host;
  await reprobeActiveProvider(host, config);
  const built = buildActiveProvider(config, deps.logger, {
    getSessionId: () => deps.sessionManager?.getActiveMeta()?.id,
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
  applyReasoningStrategy(host, config.provider);
  // Мета сессии должна отражать РЕАЛЬНОЕ окно/модель, а не снимок на create().
  deps.sessionManager?.setEffectiveContext?.(config.contextWindow, config.model);
}

/**
 * Provider-first проба контекста активной записи при смене идентичности.
 * Fail-open; при `contextAuto: false` проба пропускается целиком.
 */
async function reprobeActiveProvider(host: ProviderPhaseHost, config: AppConfig): Promise<void> {
  try {
    const nextId = probeIdentityOf(config);
    const prevId = host.lastProbeIdentity;
    const identityChanged =
      prevId.model !== nextId.model ||
      prevId.baseUrl !== nextId.baseUrl ||
      prevId.active !== nextId.active;
    if (!identityChanged) return;
    if (config.contextAuto === false) {
      host.lastProbeIdentity = nextId;
      return;
    }
    const nextEndpoint = activeProviderEndpoint(config.provider);
    const { probeModel, probeProviderContext } = await import("../../llm/model-loader");
    const lmProbe = await probeModel(nextEndpoint.baseUrl, config.model);
    const detected =
      (lmProbe ? { model: lmProbe.model, actual: lmProbe.contextLength } : null) ??
      (await probeProviderContext(nextEndpoint.baseUrl, config.model, {
        apiKey: nextEndpoint.apiKey,
        providerType: nextEndpoint.type,
      }));
    if (detected && detected.actual !== config.contextWindow) {
      loggerOf(host)?.info(
        `Context probe: auto-set contextWindow from provider — model "${detected.model}" serves ${detected.actual} tokens (configured was ${config.contextWindow}).`,
      );
      config.contextWindow = detected.actual;
    }
    host.lastProbeIdentity = nextId;
  } catch {
    // Проба — best-effort, переключение модели/провайдера не блокируем никогда.
  }
}

/** Пересчитывает стратегию reasoning из активной записи; "none" гасит probe-флаг. */
function applyReasoningStrategy(host: ProviderPhaseHost, provider: AppConfig["provider"]): void {
  const strategy: ReasoningStrategy = reasoningStrategyForProvider(provider);
  host.deps.reasoningStrategy = strategy;
  if (strategy === "none") host.probePassed = false;
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
  });
  manager.switch(name, model);
  deps.config.provider = manager.toConfig();
  if (model !== undefined) deps.config.model = model;
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
