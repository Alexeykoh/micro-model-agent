// Менеджер провайдеров: активный провайдер + модель в рантайме, hot-swap, кеш сборки.
import type { LLMProvider } from "../../llm/provider";
import type { ProviderConfig, ProviderEntry, ReasoningStrategy, ModelCapabilities } from "../../config/types";
import type { ProviderRegistry } from "./registry";
import type { ProviderCapabilities } from "./types";
import { createProvider, defaultRegistry } from "./create";
import { resolveCacheCapability } from "./cache";
import { resolveModelCapabilities } from "./capabilities";
import { BUILTIN_PROVIDERS } from "./presets";
import { t } from "../../i18n/index";
import { getEgressGuard, SanitizingProvider } from "./sanitizing";

export interface ProviderManagerOptions {
  contextWindow: number;
  retry?: import("../../config/types").RetryConfig;
  rateLimits?: Partial<import("../../config/types").RateLimitConfig>;
  registry?: ProviderRegistry;
  /** Живой id беседы, прокидывается провайдерам (`x-opencode-session`). */
  getSessionId?: () => string | undefined;
  /** Конфиг-оверрайды возможностей по модели (`config.modelCapabilities`). */
  modelCapabilities?: Record<string, ModelCapabilities>;
  /** Живая native-проба возможностей активной модели (уточняет пресет). */
  probeCapabilities?: () => ModelCapabilities | undefined;
  /** Опциональный логгер диагностики LLM-запросов/ответов. */
  logger?: import("../../logger/app-logger").Logger;
  /** Общий лимитер запросов на процесс (аудит §7.8). */
  sharedLimiter?: import("../../llm/shared-rate-limiter").RateLimiter;
}

/**
 * Рулит активным провайдером + моделью в рантайме. Несколько настроенных
 * провайдеров (`ProviderConfig.entries`) с hot-swap (`switch`, `setModel`).
 * Легаси-конфиги (`{type, baseUrl, apiKey}`) нормализуются в список из одной
 * записи — старые конфиги продолжают работать.
 */
export class ProviderManager {
  private entries: ProviderEntry[];
  private providerConfig: ProviderConfig;
  private lastKnownFallback?: boolean;
  private activeProviderName: string;
  private model: string;
  private opts: ProviderManagerOptions;
  private registry: ProviderRegistry;
  private cache = new Map<string, LLMProvider>();

  constructor(config: ProviderConfig, opts: ProviderManagerOptions) {
    this.opts = opts;
    this.registry = opts.registry ?? defaultRegistry();
    // Своя копия: `switch()` — рантайм-состояние (probe/failover), а не выбор
    // пользователя; иначе probe всех entries молча подменяет active и его персистит save.
    this.providerConfig = { ...config };
    this.entries = this.normalizeEntries(this.providerConfig);
    this.activeProviderName = this.resolveActive(this.providerConfig);
    this.lastKnownFallback = this.providerConfig.fallback;
    this.model = "";
  }

  /** Модель, с которой собран активный провайдер. */
  get activeModel(): string {
    return this.model;
  }

  /** Имя/label активного провайдера. */
  get activeName(): string {
    return this.activeProviderName;
  }

  /** Активный провайдер (строится и кешируется). */
  get active(): LLMProvider {
    return this.build(this.activeProviderName);
  }

  /** Активная запись (неизвестная — ошибка). */
  get activeEntry(): ProviderEntry {
    const entry = this.entryByName(this.activeProviderName);
    if (!entry) throw new Error(`Unknown active provider "${this.activeProviderName}"`);
    return entry;
  }

  /** Все записи (с метаданными пресетов), по приоритету. */
  list(): Array<ProviderEntry & { label: string }> {
    return this.entries
      .map((e) => {
        const preset = this.registry.get(e.type);
        return { ...e, label: e.label || preset?.label || e.type };
      })
      .map((e, i) => ({ e, i, p: e.priority ?? Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.p - b.p || a.i - b.i)
      .map(({ e }) => e);
  }

  /** Имена всех записей по приоритету. */
  listNames(): string[] {
    return this.list().map((e) => e.label);
  }

  /**
   * CODE-ONLY роутинг capabilities: первая запись (по приоритету), чей пресет
   * и окно контекста закрывают `needs`. Модели не exposed — модель провайдеров
   * не выбирает.
   */
  pickFor(needs: {
    vision?: boolean;
    tools?: boolean;
    minContext?: number;
  }): string | undefined {
    const globalWindow = this.opts.contextWindow;
    // Без ограничений — оставить текущий активный провайдер.
    if (!needs.vision && !needs.tools && needs.minContext === undefined) {
      return this.activeProviderName;
    }
    // Возможности модели — через единый резолвер (preset → probe → override),
    // а не сырой `registry.get(type).capabilities`: пресет заявляет vision/tools
    // на уровне провайдера и не знает ни живой пробы, ни конфиг-оверрайда
    // пользователя — второй источник правды по capabilities (W8, D6).
    const override = this.opts.modelCapabilities?.[this.model];
    const probe = this.opts.probeCapabilities?.();
    for (const e of this.list()) {
      const caps = resolveModelCapabilities(this.registry.get(e.type)?.capabilities, probe, override);
      if (needs.vision && !caps.vision) continue;
      if (needs.tools && !caps.tools) continue;
      if (
        needs.minContext !== undefined &&
        (e.contextWindow ?? globalWindow) < needs.minContext
      ) {
        continue;
      }
      return e.label;
    }
    return undefined;
  }

  /** Hot-swap на именованный провайдер; пересобрать активный. */
  switch(name: string, model?: string): LLMProvider {
    if (!this.entryByName(name)) {
      throw new Error(t("provider.unknown", { name }));
    }
    this.activeProviderName = name;
    if (model !== undefined) this.model = model;
    // Только своё состояние: живой `config.provider` не трогаем — иначе probe/
    // failover подменяет выбор; явный `/provider use` персистит через `toConfig()`.
    this.providerConfig.active = name;
    return this.active;
  }

  /** Модель, закреплённая за провайдером (`provider.models[name]`). */
  modelFor(name: string): string | undefined {
    return this.providerConfig.models?.[name];
  }

  /** Пересобрать активный провайдер с новой моделью. */
  setModel(model: string): LLMProvider {
    this.model = model;
    // Кэш ключуется `${name}|${model}`: записи под прежнюю модель бесполезны — сбрасываем.
    this.resetCache();
    return this.active;
  }

  /** Сериализовать обратно в ProviderConfig (active/entries в синхроне). */
  toConfig(fallback?: boolean): ProviderConfig {
    const active = this.activeEntry;
    return {
      active: this.activeProviderName,
      entries: this.entries,
      // Сохранить настроенное значение — хардкод false молча ронял
      // пользовательский provider.fallback при каждом hot-swap.
      fallback: fallback ?? this.lastKnownFallback ?? false,
      type: active.type,
      baseUrl: active.baseUrl,
      apiKey: active.apiKey,
    };
  }

  private normalizeEntries(config: ProviderConfig): ProviderEntry[] {
    if (Array.isArray(config.entries) && config.entries.length > 0) {
      return config.entries.map((e) => ({ ...e, label: e.label || e.type }));
    }
    // Легаси-форма одного провайдера (или пустой конфиг) → одна дефолтная запись.
    return [
      {
        type: config.type ?? "openai-compat",
        label: config.type ?? "openai-compat",
        baseUrl: config.baseUrl ?? "",
        apiKey: config.apiKey,
        maxCompletionTokens: config.maxCompletionTokens,
      },
    ];
  }

  private resolveActive(config: ProviderConfig): string {
    if (config.active && this.entryByName(config.active)) return config.active;
    const first = this.entries[0];
    return first ? (first.label ?? "openai-compat") : "openai-compat";
  }

  private entryByName(name: string): ProviderEntry | undefined {
    return this.entries.find((e) => e.label === name || e.type === name);
  }

  private build(name: string): LLMProvider {
    const entry = this.entryByName(name);
    if (!entry) throw new Error(t("provider.unknown", { name }));
    const key = `${name}|${this.model}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    let provider = createProvider(entry.type, {
      model: this.model,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
      contextWindow: entry.contextWindow ?? this.opts.contextWindow,
      retry: entry.retry ?? this.opts.retry,
      rateLimits: entry.rateLimits ?? this.opts.rateLimits,
      rateLimiter: this.opts.sharedLimiter,
      maxCompletionTokens: entry.maxCompletionTokens,
      getSessionId: this.opts.getSessionId,
      capabilities: this.resolveCapabilities(entry),
      logger: this.opts.logger,
    }, this.registry);
    // E1: единственная точка сборки — обёртка DLP здесь закрывает обе фабрики
    // (активную и managed) и failover (FallbackProvider читает `manager.active`).
    const egress = getEgressGuard({
      type: entry.type,
      baseUrl: entry.baseUrl ?? "",
      sessionId: this.opts.getSessionId?.(),
    });
    if (egress) provider = new SanitizingProvider(provider, egress);
    this.cache.set(key, provider);
    return provider;
  }

  /** Возможности пресета с наложенным переопределением кеша из записи. */
  private resolveCapabilities(entry: ProviderEntry): Partial<ProviderCapabilities> {
    const spec = this.registry.get(entry.type);
    if (!spec) return { cache: resolveCacheCapability(undefined, entry.cache) };
    // Механизм reasoning — трёхслойно (INV-R2), как vision/tools: оверрайд
    // модели → живая проба → пресет. Экземпляр получает РЕЗОЛВНУТЫЙ механизм.
    const caps = resolveModelCapabilities(
      spec.capabilities,
      this.opts.probeCapabilities?.(),
      this.opts.modelCapabilities?.[this.model],
    );
    return {
      ...spec.capabilities,
      reasoningStrategy: caps.reasoningStrategy ?? spec.capabilities.reasoningStrategy,
      reasoningOff: caps.reasoningOff ?? spec.capabilities.reasoningOff,
      cache: resolveCacheCapability(spec, entry.cache),
    };
  }

  /** Очистить кеш сборки (при смене конфига). */
  resetCache(): void {
    this.cache.clear();
  }
}

/** Метаданные пресетов для CLI (label/capabilities/baseUrl). */
export function presetOf(type: string): { label: string; baseUrl: string } | undefined {
  const spec = BUILTIN_PROVIDERS.find((p) => p.type === type);
  if (!spec) return undefined;
  return { label: spec.label, baseUrl: spec.baseUrl };
}

/**
 * Эндпоинт АКТИВНОГО провайдера для внеполосных вызовов (context probe,
 * автозагрузка моделей, ключ кеша reasoning-пробы). Легаси-плоские поля
 * (`type`/`baseUrl`/`apiKey`) отражают активное на момент последней записи и
 * протухают после hot-swap `/provider use` — истина в entries. Фолбэк на
 * плоские поля для легаси-конфигов.
 */
export function activeProviderEndpoint(
  config?: Pick<ProviderConfig, "entries" | "active" | "type" | "baseUrl" | "apiKey">,
): {
  baseUrl: string;
  apiKey?: string;
  type: string;
} {
  const entries = Array.isArray(config?.entries) ? config.entries : [];
  const active =
    entries.find((e) => e.label === config?.active || e.type === config?.active) ?? entries[0];
  if (active) {
    return { baseUrl: active.baseUrl, apiKey: active.apiKey, type: active.type };
  }
  return { baseUrl: config?.baseUrl ?? "", apiKey: config?.apiKey, type: config?.type ?? "openai-compat" };
}

/**
 * Стратегия reasoning АКТИВНОЙ записи провайдера — через ЕДИНЫЙ резолвер
 * capabilities (INV-R2), трёхслойно: оверрайд модели → проба → пресет.
 * Легаси-плоское `type` протухает после hot-swap `/provider use` и давало чужую
 * стратегию; неизвестный тип → "none".
 */
export function reasoningStrategyForProvider(
  config?: Pick<ProviderConfig, "entries" | "active" | "type" | "baseUrl" | "apiKey">,
  probe?: ModelCapabilities,
  override?: ModelCapabilities,
): ReasoningStrategy {
  const type = activeProviderEndpoint(config).type;
  const spec = BUILTIN_PROVIDERS.find((p) => p.type === type);
  return resolveModelCapabilities(spec?.capabilities, probe, override).reasoningStrategy ?? "none";
}
