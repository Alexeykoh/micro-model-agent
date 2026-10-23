// P2 (аудит 2026-10-23): секция «план» в сайдбаре пустела, пока в ленте висел
// живой план-блок. Снапшот `state` приходит с `plan: null`, если
// `getActivePlan()` разрешился в другой ExecutionModule (runner vs shared), а
// событие `plan` — нет. Сайдбар обязан следовать событию, не дожидаясь `state`.
//
// Тест держит два факта фикса: (1) событие кладёт шаги в вкладку (`livePlan`),
// (2) по ним рендерится секция сайдбара — именно это делает `renderActiveState`.
// Вкладка намеренно не активна: у активной `appendTo` дёргает `scroll()`, а
// `msgs` в общем модуле захвачен при импорте и может быть чужим для теста.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const HTML = `<div id="plan"></div><div id="planCount"></div><div id="msgs"><div class="feed"></div></div>`;

describe("сайдбар плана следует за событием `plan`", () => {
  it("кладёт шаги вкладки и рендерит секцию без снапшота `state`", async () => {
    setupHappyDom(HTML);
    const store = await import("../src/modules/webui/assets/js/store");
    const { onPlan, renderPlan } = await import("../src/modules/webui/assets/js/feed/plan");
    const tabState = store.tabs as unknown as { tabs: unknown[]; activeTabId: string };

    const saved = tabState.tabs.slice();
    const savedActive = tabState.activeTabId;
    try {
      tabState.tabs.length = 0;
      tabState.tabs.push({ id: "ses_plan", feed: document.createElement("div"), state: {}, kind: "session" });
      tabState.activeTabId = "ses_other";

      onPlan({
        sessionId: "ses_plan",
        steps: [{ text: "шаг один" }, { text: "шаг два" }],
        currentIndex: 1,
      });

      const tab = tabState.tabs[0] as { livePlan?: { steps: unknown[]; currentIndex: number } };
      expect(tab.livePlan?.steps).toHaveLength(2);

      renderPlan(tab.livePlan);
      const planEl = document.getElementById("plan") as HTMLElement;
      expect(planEl.textContent).toContain("шаг один");
      expect(planEl.textContent).toContain("шаг два");
      // Тот же счётчик, что у карточки в ленте.
      expect(document.getElementById("planCount")?.textContent).toBe("0 / 2");
    } finally {
      tabState.tabs.length = 0;
      for (const t of saved) tabState.tabs.push(t);
      tabState.activeTabId = savedActive;
    }
  });

  it("пустой план возвращает секцию в состояние «нет активного плана»", async () => {
    setupHappyDom(HTML);
    const { renderPlan } = await import("../src/modules/webui/assets/js/feed/plan");
    renderPlan(null);
    expect(document.getElementById("plan")?.textContent).not.toContain("шаг");
  });
});
