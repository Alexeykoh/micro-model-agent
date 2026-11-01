// Фоновый кеш списков моделей для `GET /api/models` (эндпоинт синхронен,
// провайдер — нет). Один кеш на активного провайдера + ленивые per-provider
// списки: страница настроек запрашивает модели конкретной записи, чтобы
// эксперт можно было пришпилить к другому провайдеру.
/**
 * Вынесен из `module.ts` (правило #1: ≤300 строк/файл). Активный список
 * обновляется раз при старте (best-effort) и на каждый reconfigure — следуя за
 * активным провайдером, а не протухая. Офлайн-провайдер оставляет прежний
 * список (или пустой, если его ещё не было), а не роняет запрос.
 */
import type { Agent } from "../../../core/api";
import type { AppConfig } from "../../../config/types";

/** Срез списка моделей одного провайдера для HTTP-ответа. */
export interface ProviderModels {
  models: string[];
  /** true — список ещё грузится (первый запрос к записи); клиент перезапросит. */
  loading: boolean;
}

/** Кеш списка моделей: чтение и обновление от активного провайдера. */
export interface ModelCache {
  /** Живые id моделей активного провайдера (сорт); подкючён к `state.knownModels`. */
  get: () => string[];
  /** Модели именованной записи (ленивая загрузка); `state.knownModelsFor`. */
  getFor: (name: string) => ProviderModels;
  /** Обновить активного провайдера; вешается хуком reconfigure. */
  refresh: () => Promise<void>;
}

/** Строит кеш на агенте и конфиге (активный провайдер резолвится при каждом refresh). */
export function makeModelCache(
  agent: Pick<Agent, "getProviderFor">,
  config: AppConfig,
): ModelCache {
  const byProvider = new Map<string, string[]>();
  const loading = new Set<string>();
  const activeName = (): string =>
    config.provider.active || config.provider.entries?.[0]?.label || config.provider.type || "";

  const refreshName = async (name: string): Promise<void> => {
    if (!name || loading.has(name)) return;
    loading.add(name);
    try {
      const provider = agent.getProviderFor(name);
      if (!provider) {
        if (!byProvider.has(name)) byProvider.set(name, []);
        return;
      }
      const models = await provider.listModels();
      byProvider.set(name, models.slice().sort());
    } catch {
      // Офлайн-провайдер: прежний список, а если его не было — пустой.
      if (!byProvider.has(name)) byProvider.set(name, []);
    } finally {
      loading.delete(name);
    }
  };

  const refresh = async (): Promise<void> => {
    await refreshName(activeName());
  };

  return {
    get: () => byProvider.get(activeName()) ?? [],
    getFor(name: string): ProviderModels {
      const key = name.trim();
      if (!key) return { models: byProvider.get(activeName()) ?? [], loading: false };
      if (byProvider.has(key)) return { models: byProvider.get(key) ?? [], loading: false };
      void refreshName(key);
      return { models: [], loading: true };
    },
    refresh,
  };
}
