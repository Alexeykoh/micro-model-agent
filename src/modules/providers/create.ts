// src/modules/providers/create.ts
import type { LLMProvider } from "../../llm/provider";
import type { ProviderRegistry } from "./registry";
import type { ProviderOptions } from "./types";
import { BUILTIN_PROVIDERS } from "./presets";
import { ProviderRegistry as Registry } from "./registry";

/**
 * The single entry point for building a provider. Unknown types fall back to
 * the OpenAI-compatible provider (backward compatible with legacy configs that
 * use a custom `type` + baseUrl).
 */
export function createProvider(
  type: string,
  opts: ProviderOptions,
  registry: ProviderRegistry = defaultRegistry(),
): LLMProvider {
  const spec = registry.get(type);
  if (!spec) {
    return BUILTIN_PROVIDERS[0].create(opts);
  }
  return spec.create(opts);
}

/** Registry preloaded with all builtin provider presets. */
export function defaultRegistry(): ProviderRegistry {
  const registry = new Registry();
  for (const spec of BUILTIN_PROVIDERS) {
    registry.register(spec);
  }
  return registry;
}