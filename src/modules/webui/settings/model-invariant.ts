// Инвариант INV-P1: активная модель обязана быть в списке активного
// провайдера. Список приходит асинхронно, поэтому проверка живёт рядом с
// фоновым refresh'ем, а не в синхронной записи конфига.
import { DEFAULTS } from "../../../config/defaults";
import type { AppConfig, ProviderEntry } from "../../../config/types";
import type { ProviderModels } from "../../../runtime/model-cache";

/** Коллабораторы, нужные для очистки недоказанной модели. */
export interface ModelInvariantState {
  saveConfig?: (config: AppConfig, key?: string) => void;
}

export interface ModelInvariantAgent {
  reconfigure(config: AppConfig, opts?: { probe?: boolean }): void | Promise<void>;
}

/** Активная запись провайдера (легаси-конфиг без `entries` — нет записи). */
function activeEntry(config: AppConfig): ProviderEntry | undefined {
  const name = config.provider.active || config.provider.type;
  return (config.provider.entries ?? []).find((e) => e.label === name || e.type === name);
}

/**
 * true — модель явно разрешена для записи, хотя её нет в `/models` (алиас).
 * Провайдеры принимают такие id, но не перечисляют их; стирать их нельзя.
 */
export function modelAllowlisted(config: AppConfig, model: string): boolean {
  const allowed = activeEntry(config)?.unlistedModels;
  return Array.isArray(allowed) && allowed.includes(model);
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
  if (!model.length) return false;
  return view.models.indexOf(model) === -1 && !modelAllowlisted(config, model);
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
  const unsupported = activeModelUnsupported(config, view);
  // Нет модели (уже пусто или сейчас очистим) — окно контекста тоже не имеет
  // владельца. Ручное значение сбрасываем в auto, авто-значение — в дефолт:
  // иначе проба прошлой модели (напр. 1M) висит на несуществующем выборе.
  const emptyModel = unsupported || !String(config.model || "").trim();
  const staleContext =
    emptyModel &&
    (config.contextAuto === false || config.contextWindow !== DEFAULTS.contextWindow);
  if (!unsupported && !staleContext) return false;

  if (unsupported) {
    const name = config.provider.active || config.provider.type;
    config.model = "";
    // Память провайдера не должна восстановить отозванный id при следующем
    // свитче — иначе инвариант снова нарушится на ровном месте.
    if (name && config.provider.models) delete config.provider.models[name];
  }
  // Ручное окно контекста принадлежало удалённой модели. Оставить его — значит
  // применить 1M к следующей модели, у которой окно меньше. Возвращаем auto:
  // окно новой модели определит проба, а не память о старой.
  if (staleContext) {
    config.contextAuto = true;
    config.contextWindow = DEFAULTS.contextWindow;
  }
  try {
    // `model`/память и окно контекста живут в разных доменах файла конфига.
    if (unsupported) {
      state.saveConfig?.(config, "model");
      state.saveConfig?.(config, "provider.active");
    }
    if (staleContext) state.saveConfig?.(config, "contextWindow");
  } catch {
    /* провал персиста не отменяет очистку в памяти */
  }
  await agent.reconfigure(config, { probe: false });
  return true;
}
