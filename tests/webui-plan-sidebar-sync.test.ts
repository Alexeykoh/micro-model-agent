// P2 (аудит 2026-10-23): секция «план» в сайдбаре пустела, пока в ленте висел
// живой план-блок. Снапшот `state` приходит с `plan: null`, если
// `getActivePlan()` разрешился в другой ExecutionModule (runner vs shared), а
// событие `plan` — нет. Сайдбар обязан следовать событию, не дожидаясь `state`.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

describe("сайдбар плана следует за событием `plan`", () => {
  it("заполняет секцию активной вкладки сразу, без снапшота `state`", async () => {
    setupHappyDom(
      `<div id="plan"></div><div id="planCount"></div><div id="msgs"><div class="feed"></div></div>`,
    );
    const { tabs: tabState } = await import("../src/modules/webui/assets/js/store");
    const { onPlan } = await import("../src/modules/webui/assets/js/feed/plan");
    const feedEl = document.querySelector("#msgs .feed") as HTMLElement;
    tabState.tabs.length = 0;
    tabState.tabs.push({ id: "ses_1", feed: feedEl, state: {}, kind: "session" } as never);
    tabState.activeTabId = "ses_1";

    onPlan({
      sessionId: "ses_1",
      steps: [{ text: "шаг один" }, { text: "шаг два" }],
      currentIndex: 1,
    });

    const planEl = document.getElementById("plan") as HTMLElement;
    expect(planEl.textContent).toContain("шаг один");
    expect(planEl.textContent).toContain("шаг два");
    // Тот же счётчик, что у карточки в ленте.
    expect(document.getElementById("planCount")?.textContent).toBe("0 / 2");
    // Живой план запомнен на вкладке — снапшот `state` с `plan: null` его не сотрёт.
    expect((tabState.tabs[0] as unknown as { livePlan?: { steps: unknown[] } }).livePlan?.steps)
      .toHaveLength(2);
  });

  it("чужое событие (не активная вкладка) не перебивает сайдбар", async () => {
    setupHappyDom(
      `<div id="plan"></div><div id="planCount"></div><div id="msgs"><div class="feed"></div></div>`,
    );
    const { tabs: tabState } = await import("../src/modules/webui/assets/js/store");
    const { onPlan } = await import("../src/modules/webui/assets/js/feed/plan");
    const active = document.querySelector("#msgs .feed") as HTMLElement;
    const other = document.createElement("div");
    tabState.tabs.length = 0;
    tabState.tabs.push({ id: "ses_active", feed: active, state: {}, kind: "session" } as never);
    tabState.tabs.push({ id: "ses_other", feed: other, state: {}, kind: "session" } as never);
    tabState.activeTabId = "ses_active";

    onPlan({ sessionId: "ses_other", steps: [{ text: "чужой шаг" }], currentIndex: 0 });

    const planEl = document.getElementById("plan") as HTMLElement;
    expect(planEl.textContent).not.toContain("чужой шаг");
  });
});
