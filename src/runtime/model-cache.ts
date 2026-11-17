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
  /** true — провайдер не ответил (офлайн/ошибка), а не «моделей нет». */
  error?: boolean;
}

/** Кеш списка моделей: чтение и обновление от активного провайдера. */
export interface ModelCache {
  /** Живые id моделей активного провайдера (сорт). */
  get: () => string[];
  /** Активный провайдер: список + честный статус загрузки/ошибки. */
  getActiveState: () => ProviderModels;
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
  /** Провайдер ответил ошибкой: пустой список — «не смогли», не «нет моделей». */
  const failed = new Set<string>();
  const activeName = (): string =>
    config.provider.active || config.provider.entries?.[0]?.label || config.provider.type || "";

  const refreshName = async (name: string): Promise<void> => {
    if (!name || loading.has(name)) return;
    loading.add(name);
    try {
      const provider = agent.getProviderFor(name);
      if (!provider) {
        failed.add(name);
        return;
      }
      const models = await provider.listModels();
      byProvider.set(name, models.slice().sort());
      failed.delete(name);
    } catch {
      // Офлайн-провайдер: держим прежний список, если он был; иначе списка нет
      // (пустой массив означал бы «провайдер ответил, моделей ноль»).
      failed.add(name);
    } finally {
      loading.delete(name);
    }
  };

  const refresh = async (): Promise<void> => {
    await refreshName(activeName());
  };

  const stateFor = (name: string): ProviderModels => {
    const models = byProvider.get(name) ?? [];
    // `loading` means "no usable list yet", not "a refresh is running": if we
    // already have a list, a background refresh must not repaint the panel as
    // «загрузка моделей…» (observed live: 32 models + loading:true).
    const hasList = byProvider.has(name);
    const isLoading = !hasList && (loading.has(name) || !failed.has(name));
    return !hasList && failed.has(name)
      ? { models, loading: isLoading, error: true }
      : { models, loading: isLoading };
  };

  return {
    get: () => byProvider.get(activeName()) ?? [],
    getActiveState: () => stateFor(activeName()),
    getFor(name: string): ProviderModels {
      const key = name.trim();
      if (!key) return stateFor(activeName());
      if (byProvider.has(key) || failed.has(key)) return stateFor(key);
      void refreshName(key);
      return { models: [], loading: true };
    },
    refresh,
  };
}
