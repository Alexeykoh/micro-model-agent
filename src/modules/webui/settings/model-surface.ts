// Проводка списка моделей активного провайдера: источники для `state`,
// фоновый кеш, boot-проверка INV-P1 и reconfigure-хук. Вынесено из `module.ts`
// (правило 6: модуль остаётся Wiring-файлом под 300 строк).
import type { AppConfig } from "../../../config/types";
import type { Agent } from "../../../core/api";
import { broadcast, type ConfigStore, type RuntimeState, type SessionStore, type SseTransport } from "../state";
import { makeModelCache } from "./model-cache";
import { enforceActiveModel } from "./model-invariant";
import { makeReconfigure, reconfigureRunners, type WebReconfigurableAgent } from "./reconfigure";

/** Ставит `knownModels*`, reconfigure-хук и проверку модели на первом списке. */
export function installModelSurface(
  state: RuntimeState & SessionStore & SseTransport & ConfigStore,
  agent: WebReconfigurableAgent & Pick<Agent, "getProviderFor">,
  config: AppConfig,
  explicitKnownModels?: () => string[],
): void {
  // Явный источник побеждает; иначе фоновый кеш (рефреш на reconfigure).
  const modelCache = explicitKnownModels ? null : makeModelCache(agent, config);
  state.knownModels = explicitKnownModels ?? modelCache!.get;
  state.knownModelsState = modelCache?.getActiveState;
  state.knownModelsFor = modelCache?.getFor;
  if (!modelCache) {
    state.reconfigure = makeReconfigure(state, agent);
    return;
  }

  // Очистка неактуальной модели (INV-P1) применяется и к живым раннерам:
  // иначе сессия, уже получившая раннер, продолжила бы со старым id.
  const enforceNow = async (): Promise<boolean> => {
    const cleared = await enforceActiveModel(state, agent, config, modelCache.getActiveState());
    if (cleared) await reconfigureRunners(state, config);
    return cleared;
  };
  // Рефреш + проверка + публикация: один путь для boot и кнопки «повторить».
  // `models` обязателен — иначе открытая панель так и останется на «загрузке»,
  // ведь другого повода перезапросить список после boot нет.
  const refreshAndPublish = async (): Promise<void> => {
    await modelCache.refresh();
    let cleared = false;
    try {
      cleared = await enforceNow();
    } catch {
      /* сбой проверки не отменяет публикацию списка */
    }
    broadcast({ type: "models", ts: Date.now() }, state);
    if (cleared) broadcast({ type: "config", ts: Date.now() }, state);
  };
  void refreshAndPublish();
  state.knownModelsRefresh = refreshAndPublish;
  state.reconfigure = makeReconfigure(state, agent, () => modelCache.refresh(), enforceNow);
}
