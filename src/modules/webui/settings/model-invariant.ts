// Инвариант INV-P1: активная модель обязана быть в списке активного
// провайдера. Список приходит асинхронно, поэтому проверка живёт рядом с
// фоновым refresh'ем, а не в синхронной записи конфига.
import type { AppConfig } from "../../../config/types";
import type { ProviderModels } from "../../../runtime/model-cache";

/** Коллабораторы, нужные для очистки недоказанной модели. */
export interface ModelInvariantState {
  saveConfig?: (config: AppConfig, key?: string) => void;
}

export interface ModelInvariantAgent {
  reconfigure(config: AppConfig, opts?: { probe?: boolean }): void | Promise<void>;
}

/**
 * true — модель нельзя показывать активной: список уже получен без ошибки,
 * он непустой и модели в нём нет. `loading`/`error` ничего не доказывают —
 * в этих состояниях конфиг не трогаем (fail-open, без потери рабочей модели).
 */
export function activeModelUnsupported(
  config: AppConfig,
  view: ProviderModels | undefined,
): boolean {
  if (!view || view.loading || view.error || !view.models.length) return false;
  const model = String(config.model || "").trim();
  return model.length > 0 && view.models.indexOf(model) === -1;
}

/**
 * Сбрасывает активную модель, которой нет у активного провайдера, и
 * пересобирает агента без сети. Возвращает true, если конфиг изменился:
 * вызывающая сторона должна разослать SSE `config`.
 */
export async function enforceActiveModel(
  state: ModelInvariantState,
  agent: ModelInvariantAgent,
  config: AppConfig,
  view: ProviderModels | undefined,
): Promise<boolean> {
  if (!activeModelUnsupported(config, view)) return false;
  const name = config.provider.active || config.provider.type;
  config.model = "";
  // Память провайдера не должна восстановить отозванный id при следующем
  // свитче — иначе инвариант снова нарушится на ровном месте.
  if (name && config.provider.models) delete config.provider.models[name];
  try {
    // `model` и `provider.models` живут в разных доменах файла конфига.
    state.saveConfig?.(config, "model");
    state.saveConfig?.(config, "provider.active");
  } catch {
    /* провал персиста не отменяет очистку в памяти */
  }
  await agent.reconfigure(config, { probe: false });
  return true;
}
