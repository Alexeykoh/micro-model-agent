// Создание провайдера по типу + реестр с builtin-пресетами.
// src/modules/providers/create.ts
import type { LLMProvider } from "../../llm/provider";
import type { ProviderRegistry } from "./registry";
import type { ProviderOptions } from "./types";
import { BUILTIN_PROVIDERS } from "./presets";
import { ProviderRegistry as Registry } from "./registry";

/**
 * Единая точка сборки провайдера. Неизвестные типы откатываются на
 * OpenAI-совместимый (совместимость с легаси-конфигами: кастомный `type` + baseUrl).
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

/** Реестр, предзагруженный всеми builtin-пресетами. */
export function defaultRegistry(): ProviderRegistry {
  const registry = new Registry();
  for (const spec of BUILTIN_PROVIDERS) {
    registry.register(spec);
  }
  return registry;
}