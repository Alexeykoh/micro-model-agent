// Вебовый хук `reconfigure` — вынесен из `module.ts` (правило #1).
import type { AppConfig } from "../../../config/types";
import { broadcast, type RuntimeState, type SessionStore, type SseTransport } from "../state";
import { pushState } from "../session/session-status";

/**
 * Поверхность агента для веб-хука reconfigure. Узкая, чтобы тесты стабили
 * без конструирования настоящего `Agent` (а то потянет всю петлю).
 */
export interface WebReconfigurableAgent {
  reconfigure(config: AppConfig, opts?: { probe?: boolean }): void | Promise<void>;
  readonly contextManager: { getBudget(): { history: number } };
}

/**
 * Строит вебовый хук `reconfigure`. Он может менять окно/бюджет контекста,
 * и кешнутый лимит сайдбара (история прошлого хода, `budget.history`) протухает.
 * Перечитываем живой бюджет и пушим событие `state`, чтобы браузер обновился
 * сразу, не дожидаясь следующего хода или 2с-полла `/api/state`.
 */
export function makeReconfigure(
  state: RuntimeState & SessionStore & SseTransport,
  agent: WebReconfigurableAgent,
  after?: () => Promise<void> | void,
): (config: AppConfig) => Promise<void> {
  return async (config) => {
    const windowBefore = config.contextWindow;
    await agent.reconfigure(config);
    const probeChanged = config.contextWindow !== windowBefore;
    // Конфиг shared-объект, но бюджеты/провайдер живут в агентах: догоняем
    // всех закешированных раннеров (best-effort, по одному — редкая операция).
    // Проба — один раз на операцию (INV-W6): раннеры применяют конфиг с
    // `{ probe: false }`, сетевую context-probe делает только основной агент.
    for (const id of state.pool.runnerIds()) {
      try {
        await state.pool.getRunner(id)?.agent.reconfigure(config, { probe: false });
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
    // Провайдер мог смениться: рефреш списка моделей уходит в ФОН (INV-W5 —
    // сеть не входит в путь ответа `POST /api/config`), а его результат клиент
    // получает событиями `models` (и `config`, если проба подправила окно).
    pushState(state);
    if (after) void refreshModelsInBackground(state, after, probeChanged);
  };
}

/**
 * Фоновый рефреш списка моделей: результат сообщается SSE-событиями, а не
 * HTTP-ответом. Провал рефреша не отменяет уже применённый reconfigure.
 */
async function refreshModelsInBackground(
  state: SseTransport,
  after: () => Promise<void> | void,
  probeChanged: boolean,
): Promise<void> {
  try {
    await after();
  } catch {
    /* результат reconfigure сохраняем, даже если рефреш моделей упал */
  }
  broadcast({ type: "models", ts: Date.now() }, state);
  if (probeChanged) broadcast({ type: "config", ts: Date.now() }, state);
}
