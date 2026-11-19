// Публичный фасад модуля провайдеров: реестр, менеджер, кеш, health, пресеты.
// src/modules/providers/index.ts
export type {
  ProviderCapabilities,
  ProviderOptions,
  ProviderSpec,
} from "./types";
export { ProviderRegistry } from "./registry";
export { createProvider, defaultRegistry } from "./create";
export { ProviderManager, presetOf } from "./manager";
export { resolveCacheCapability, NO_CACHE_CAPABILITY } from "./cache";
export type { CacheCapability, CacheMechanism, CacheReportFormat } from "../../config/types";
export {
  probeProviders,
  targetsFromProviders,
  type ProbeTarget,
  type ProviderHealth,
} from "./health";
export { BUILTIN_PROVIDERS, HOSTED_BASE_URLS } from "./presets";