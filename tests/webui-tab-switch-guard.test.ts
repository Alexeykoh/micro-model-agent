// A1/A2 (INV-W8, спека 2026-11-04-webui-latency-design): переключение вкладки
// обязано быть видно и блокировать ввод, а ответы прошлого переключения —
// не применяться. Структурные проверки исходников: поведение собирается из
// четырёх файлов, и каждый шов ловится отдельно.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(p, "utf8");

const tabs = read("src/modules/webui/assets/js/session/tabs.ts");
const tabSwitch = read("src/modules/webui/assets/js/session/tab-switch.ts");
const switchState = read("src/modules/webui/assets/js/session/switch-state.ts");
const trace = read("src/modules/webui/assets/js/sidebar/trace.ts");
const history = read("src/modules/webui/assets/js/feed/history.ts");

describe("tab switch: guard and blocking (INV-W8)", () => {
  it("openTab and closeTab bump the switch sequence", () => {
    // Без номера переключения activate(A), пришедший после клика по B,
    // оставлял бы на сервере активную закрытую вкладку.
    expect(tabs).toContain("const seq = nextSwitchSeq();");
    // openTab + closeTab: activate ответившей вкладки уже неактуален.
    expect(tabs.split("nextSwitchSeq()").length - 1).toBeGreaterThanOrEqual(2);
    expect(tabs).toContain('activateServerSession, nextSwitchSeq } from "./tab-switch.js"');
  });

  it("the activate/history callback checks the sequence before global effects", () => {
    expect(tabSwitch).toContain("export function isCurrentSwitch(seq: number): boolean");
    // Список сессий и индикатор — глобальные эффекты, их применяет только
    // актуальное переключение.
    expect(tabSwitch).toMatch(/if \(!isCurrentSwitch\(seq\)\) return;/);
    expect(tabSwitch).toContain("void deps.loadSessions();");
  });

  it("blocks the composer and the feed while the tab is switching", () => {
    expect(switchState).toContain("inp.readOnly = on");
    expect(switchState).toContain('sendBtn.setAttribute("disabled"');
    expect(switchState).toContain('msgs?.setAttribute("aria-busy"');
    // Один переключатель: индикатор сайдбара включает/выключает блокировку.
    expect(trace).toContain("setSwitching(!!on);");
  });

  it("shows a skeleton and clears it in finally, even on a failed read", () => {
    expect(history).toContain("feedSkeleton()");
    expect(history).toContain('tab.feed.setAttribute("aria-busy", "true")');
    expect(history).toContain("} finally {");
    expect(history).toContain('tab.feed.removeAttribute("aria-busy")');
    // Индикатор ставится только пока снапшота нет — данные уже на руках.
    expect(tabs).toContain("if (!tab.state) setSessionLoading(true);");
  });
});
