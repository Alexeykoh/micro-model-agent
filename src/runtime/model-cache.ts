/**
 * Кеш списков моделей (split W3b): активный провайдер + ленивые per-provider
 * списки. Живёт в runtime, потому что нужен и web-панели, и host wire.
 */
import type { Agent } from "../core/api";
import type { AppConfig } from "../config/types";

/** Срез списка моделей одного провайдера для HTTP-ответа. */
export interface ProviderModels {
  models: string[];
  /** true — список ещё грузится (первый запрос к записи); клиент перезапросит. */
  loading: boolean;
}

/** Кеш списка моделей: чтение и обновление от активного провайдера. */
export interface ModelCache {
  /** Живые id моделей активного провайдера (сорт). */
  get: () => string[];
  /** Модели именованной записи (ленивая загрузка). */
  getFor: (name: string) => ProviderModels;
  /** Обновить активного провайдера; вешается хуком reconfigure. */
  refresh: () => Promise<void>;
}

/** Строит кеш на агенте и конфиге (активный провайдер резолвится при refresh). */
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
