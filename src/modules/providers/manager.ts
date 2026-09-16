// src/modules/providers/manager.ts
import type { LLMProvider } from "../../llm/provider";
import type { ProviderConfig, ProviderEntry } from "../../config/types";
import type { ProviderRegistry } from "./registry";
import { createProvider, defaultRegistry } from "./create";
import { BUILTIN_PROVIDERS } from "./presets";

export interface ProviderManagerOptions {
  contextWindow: number;
  retry?: import("../../config/types").RetryConfig;
  rateLimits?: import("../../config/types").RateLimitConfig;
  registry?: ProviderRegistry;
  /** Live conversation id, forwarded to providers (`x-opencode-session`). */
  getSessionId?: () => string | undefined;
  /** Optional logger for LLM request/response diagnostics. */
  logger?: import("../../logger/app-logger").Logger;
}

/**
 * Manages the active provider + model at runtime. Supports several configured
 * providers (`ProviderConfig.entries`) with hot-swap (`switch`, `setModel`).
 * Legacy single-provider configs (`{type, baseUrl, apiKey}`) are normalized
 * into a single-entry list, so existing configs keep working.
 */
export class ProviderManager {
  private entries: ProviderEntry[];
  private lastKnownFallback?: boolean;
  private activeProviderName: string;
  private model: string;
  private opts: ProviderManagerOptions;
  private registry: ProviderRegistry;
  private cache = new Map<string, LLMProvider>();

  constructor(config: ProviderConfig, opts: ProviderManagerOptions) {
    this.opts = opts;
    this.registry = opts.registry ?? defaultRegistry();
    this.entries = this.normalizeEntries(config);
    this.activeProviderName = this.resolveActive(config);
    this.lastKnownFallback = config.fallback;
    this.model = "";
  }

  /** The model the active provider is built with. */
  get activeModel(): string {
    return this.model;
  }

  /** Name/label of the active provider. */
  get activeName(): string {
    return this.activeProviderName;
  }

  get active(): LLMProvider {
    return this.build(this.activeProviderName);
  }

  get activeEntry(): ProviderEntry {
    const entry = this.entryByName(this.activeProviderName);
    if (!entry) throw new Error(`Unknown active provider "${this.activeProviderName}"`);
    return entry;
  }

  /** All configured entries (resolved with preset metadata), priority-ordered. */
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

  listNames(): string[] {
    return this.list().map((e) => e.label);
  }

  /**
   * CODE-ONLY capability routing (Phase 4.4): pick the first entry (priority
   * order) whose preset capabilities and context window satisfy `needs`.
   * Never exposed to the LLM — the model must not choose providers.
   */
  pickFor(needs: {
    vision?: boolean;
    tools?: boolean;
    minContext?: number;
  }): string | undefined {
    const globalWindow = this.opts.contextWindow;
    // No constraints → keep the current active provider.
    if (!needs.vision && !needs.tools && needs.minContext === undefined) {
      return this.activeProviderName;
    }
    for (const e of this.list()) {
      const caps = this.registry.get(e.type)?.capabilities;
      if (needs.vision && !caps?.vision) continue;
      if (needs.tools && !caps?.tools) continue;
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

  /** Hot-swap to a named provider; rebuild the active provider. */
  switch(name: string, model?: string): LLMProvider {
    if (!this.entryByName(name)) {
      throw new Error(`Unknown provider "${name}"`);
    }
    this.activeProviderName = name;
    if (model !== undefined) this.model = model;
    return this.active;
  }

  /** Rebuild the active provider with a new model. */
  setModel(model: string): LLMProvider {
    this.model = model;
    return this.active;
  }

  /** Serialize back to ProviderConfig (keeps active/entries in sync). */
  toConfig(fallback?: boolean): ProviderConfig {
    const active = this.activeEntry;
    return {
      active: this.activeProviderName,
      entries: this.entries,
      // Preserve the configured value — hardcoding false silently dropped
      // the user's provider.fallback on every hot-swap.
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
    // Legacy single-provider form (or empty config) → one default entry.
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
    if (!entry) throw new Error(`Unknown provider "${name}"`);
    const key = `${name}|${this.model}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const provider = createProvider(entry.type, {
      model: this.model,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
      contextWindow: entry.contextWindow ?? this.opts.contextWindow,
      retry: entry.retry ?? this.opts.retry,
      rateLimits: entry.rateLimits ?? this.opts.rateLimits,
      maxCompletionTokens: entry.maxCompletionTokens,
      getSessionId: this.opts.getSessionId,
      logger: this.opts.logger,
    }, this.registry);
    this.cache.set(key, provider);
    return provider;
  }

  /** Clear the build cache (on config change). */
  resetCache(): void {
    this.cache.clear();
  }
}

/** Export preset metadata for the CLI (label/capabilities/baseUrl). */
export function presetOf(type: string): { label: string; baseUrl: string } | undefined {
  const spec = BUILTIN_PROVIDERS.find((p) => p.type === type);
  if (!spec) return undefined;
  return { label: spec.label, baseUrl: spec.baseUrl };
}