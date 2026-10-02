// Вебовый хук `reconfigure` — вынесен из `module.ts` (правило #1).
import type { AppConfig } from "../../../config/types";
import { broadcast, type WebUiState } from "../state";
import { sessionStatus } from "../session/session-status";

/**
 * Поверхность агента для веб-хука reconfigure. Узкая, чтобы тесты стабили
 * без конструирования настоящего `Agent` (а то потянет всю петлю).
 */
export interface WebReconfigurableAgent {
  reconfigure(config: AppConfig): void | Promise<void>;
  readonly contextManager: { getBudget(): { history: number } };
}

/**
 * Строит вебовый хук `reconfigure`. Он может менять окно/бюджет контекста,
 * и кешнутый лимит сайдбара (история прошлого хода, `budget.history`) протухает.
 * Перечитываем живой бюджет и пушим событие `state`, чтобы браузер обновился
 * сразу, не дожидаясь следующего хода или 2с-полла `/api/state`.
 */
export function makeReconfigure(
  state: WebUiState,
  agent: WebReconfigurableAgent,
  after?: () => Promise<void> | void,
): (config: AppConfig) => Promise<void> {
  return async (config) => {
    await agent.reconfigure(config);
    // Конфиг shared-объект, но бюджеты/провайдер живут в агентах: догоняем
    // всех закешированных раннеров (best-effort, по одному — редкая операция).
    for (const id of state.pool.runnerIds()) {
      try {
        await state.pool.getRunner(id)?.agent.reconfigure(config);
      } catch {
        /* результат reconfigure сохраняем, даже если раннер упал */
      }
    }
    const limit = agent.contextManager.getBudget().history;
    state.usage = { ...state.usage, contextLimit: limit };
    // Тот же лимит — во все per-session снимки, иначе чужой таб покажет
    // протухший знаменатель после смены модели/окна.
    for (const id of Object.keys(state.sessionUsage)) {
      state.sessionUsage[id] = { ...state.sessionUsage[id], contextLimit: limit };
    }
  // Провайдер мог смениться: сначала рефрешим список моделей под провайдера,
  // чтобы follow-up `/api/models` клиента увидел модели нового провайдера.
    if (after) {
      try {
        await after();
      } catch {
        /* результат reconfigure сохраняем, даже если рефреш моделей упал */
      }
    }
    broadcast({ type: "state", ts: Date.now(), ...sessionStatus(state), usage: state.usage }, state);
  };
}
