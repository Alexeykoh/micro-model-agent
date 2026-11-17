// Проводка списка моделей активного провайдера: источники для `state`,
// фоновый кеш, boot-проверка INV-P1 и reconfigure-хук. Вынесено из `module.ts`
// (правило 6: модуль остаётся Wiring-файлом под 300 строк).
import type { AppConfig } from "../../../config/types";
import type { Agent } from "../../../core/api";
import { broadcast, type ConfigStore, type RuntimeState, type SessionStore, type SseTransport } from "../state";
import { makeModelCache } from "./model-cache";
import { enforceActiveModel } from "./model-invariant";
import { makeReconfigure, type WebReconfigurableAgent } from "./reconfigure";

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
  state.knownModelsRefresh = modelCache ? () => modelCache.refresh() : undefined;
  state.knownModelsFor = modelCache?.getFor;
  if (modelCache) {
    // Boot: конфиг мог пережить ребут с моделью, которую провайдер уже не
    // отдаёт. Проверяем после первого списка (INV-P1) и сообщаем клиентам:
    // `models` обязателен — иначе открытая панель так и останется на
    // «загрузке», ведь другого повода перезапросить список после boot нет.
    void modelCache.refresh().then(async () => {
      let cleared = false;
      try {
        cleared = await enforceActiveModel(state, agent, config, modelCache.getActiveState());
      } catch {
        /* сбой проверки не отменяет публикацию списка */
      }
      broadcast({ type: "models", ts: Date.now() }, state);
      if (cleared) broadcast({ type: "config", ts: Date.now() }, state);
    });
  }
  state.reconfigure = makeReconfigure(
    state,
    agent,
    modelCache ? () => modelCache.refresh() : undefined,
    modelCache
      ? () => enforceActiveModel(state, agent, config, modelCache.getActiveState())
      : undefined,
  );
}
