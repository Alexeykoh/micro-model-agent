// Guard: падение хука плагина — внутренняя диагностика, а не сообщение для
// пользователя. Оно обязано уходить в шину с `data.diagnostic = true`, иначе
// клиент `mma web` рендерит стектрейс жёлтым блоком в обычном режиме.
//
// Регресс из стресс-теста (волна 21):
// `⚠ plugin "execution" onBeforeThink threw {"error":"TypeError: …"}`.
import { describe, it, expect } from "vitest";
import { PluginDispatcher } from "../../../src/modules/plugins/dispatch";
import { defaultOutputBus } from "../../../src/output/bus";
import type { OutputEvent } from "../../../src/output/types";
import type { AgentPlugin } from "../../../src/modules/types";

describe("диагностика падений плагинов", () => {
  it("падение onBeforeThink уходит с флагом diagnostic", () => {
    const events: OutputEvent[] = [];
    const off = defaultOutputBus.subscribe((ev) => events.push(ev));
    try {
      const broken: AgentPlugin = {
        name: "broken",
        onBeforeThink: () => {
          throw new TypeError("ctx.sessionLog?.directive is not a function");
        },
      };
      const dispatcher = new PluginDispatcher(() => [broken]);
      dispatcher.runOnBeforeThink({ iteration: 1 });
    } finally {
      off();
    }

    const crash = events.find((e) => String(e.text).includes("onBeforeThink threw"));
    expect(crash).toBeTruthy();
    expect(crash?.level).toBe("warn");
    expect(crash?.data?.diagnostic).toBe(true);
  });

  it("успешный хук ничего не пишет в шину", () => {
    const events: OutputEvent[] = [];
    const off = defaultOutputBus.subscribe((ev) => events.push(ev));
    try {
      const ok: AgentPlugin = { name: "ok", onBeforeThink: () => undefined };
      new PluginDispatcher(() => [ok]).runOnBeforeThink({ iteration: 1 });
    } finally {
      off();
    }
    expect(events.filter((e) => String(e.text).includes("onBeforeThink")).length).toBe(0);
  });
});
