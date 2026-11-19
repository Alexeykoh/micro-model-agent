// Guard: вкладка «Субагенты» показывает агента, а не иконку аккаунта.
//
// Обратная связь пользователя: Lucide `users` в табах читалась как «аккаунт
// или многопользовательская фича», а не как агенты. Вкладка теперь рисует
// голову робота (`bot`). Морда маскота на 16px читалась как «пауза» (тёмный
// квадрат с двумя светлыми полосками), поэтому для таба выбран явный глиф.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

setupHappyDom(`<div></div>`);
const core = await import("../src/modules/webui/assets/js/sidebar/core.js");

describe("иконка вкладки «Субагенты»", () => {
  it("это голова робота, а не users", () => {
    const node = core.tabIcon("subagents");

    expect(node.tagName.toLowerCase()).toBe("svg");
    // Контур головы + антенна — признаки `bot`, которых нет у `users`.
    const paths = [...node.querySelectorAll("path")].map((p) => p.getAttribute("d") || "");
    expect(paths.some((d) => d.startsWith("M12 8V4H8"))).toBe(true);
    expect(paths.some((d) => d.includes("M16 21v-2"))).toBe(false);
  });

  it("остальные вкладки — свои SVG-глифы", () => {
    expect(core.tabIcon("files").tagName.toLowerCase()).toBe("svg");
  });
});
