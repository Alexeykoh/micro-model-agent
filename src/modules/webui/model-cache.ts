// Фоновый кеш списка моделей для `GET /api/models` (эндпоинт синхронен, провайдер — нет).
/**
 * Вынесен из `module.ts` (правило #1: ≤300 строк/файл). Список обновляется раз
 * при старте (best-effort) и на каждый reconfigure — следуя за активным
 * провайдером, а не протухая. Офлайн-провайдер оставляет прежний список, а не падает.
 */
import type { Agent } from "../../core/agent";
import type { AppConfig } from "../../config/types";

/** Кеш списка моделей: чтение и обновление от активного провайдера. */
export interface ModelCache {
  /** Живые id моделей (сорт); подкючён к `state.knownModels`. */
  get: () => string[];
  /** Обновить от активного провайдера; вешается хуком reconfigure. */
  refresh: () => Promise<void>;
}

/** Строит кеш на агенте и конфиге (активный провайдер резолвится при каждом refresh). */
export function makeModelCache(
  agent: Pick<Agent, "getProviderFor">,
  config: AppConfig,
): ModelCache {
  const cache: string[] = [];
  const refresh = async (): Promise<void> => {
    try {
      const name = config.provider.active || config.provider.entries?.[0]?.label || config.provider.type;
      const provider = agent.getProviderFor(name);
      if (!provider) return;
      const models = await provider.listModels();
      cache.splice(0, cache.length, ...models.slice().sort());
    } catch {
      // Офлайн-провайдер: оставляем прежний список, а не падаем.
    }
  };
  return { get: () => cache, refresh };
}
