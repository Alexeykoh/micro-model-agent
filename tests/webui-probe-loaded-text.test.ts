// Guard: панель «Сессия» не показывает лимит контекста от прежней модели.
//
// Регресс из стресс-теста (волна 13): при окне 131 072 панель печатала
// «загруженный контекст 1000.0K» — это `contextProbe` от deepseek (actual
// 1 000 000), который bootstrap снял до переключения на e4b и больше не
// обновлял. Чужую пробу показываем как «—».
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

setupHappyDom(`<div id="msgs"></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "ru";
i18n.I18N.dicts = { ru: { "web.usage.probe_loaded": "загружено {actual}" } };

const sidebar = await import("../src/modules/webui/assets/js/feed/sidebar.js");

describe("загруженный контекст: сверка модели", () => {
  it("проба своей модели показывается", () => {
    const v = sidebar.probeLoadedText(
      { model: "nvidia-nemotron-3.5-bolt-e4b", actual: 131072 },
      "nvidia-nemotron-3.5-bolt-e4b",
      131072,
    );

    expect(v.text).not.toBe("—");
    expect(v.text).toContain("131");
    expect(v.cls).toBe("");
  });

  it("проба чужой модели скрывается", () => {
    const v = sidebar.probeLoadedText(
      { model: "deepseek-v4.1-flash", actual: 1000000 },
      "nvidia-nemotron-3.5-bolt-e4b",
      131072,
    );

    expect(v.text).toBe("—");
    expect(v.cls).toBe("dim");
  });

  it("загружено меньше окна — предупреждение", () => {
    const v = sidebar.probeLoadedText({ model: "m", actual: 4096 }, "m", 131072);

    expect(v.cls).toBe("wn");
  });

  it("пробы нет — прочерк", () => {
    expect(sidebar.probeLoadedText(null, "m", 131072)).toEqual({ text: "—", cls: "dim" });
    expect(sidebar.probeLoadedText(undefined, "m")).toEqual({ text: "—", cls: "dim" });
  });

  it("проба без поля model не отбрасывается", () => {
    const v = sidebar.probeLoadedText({ actual: 8192 }, "m", 8192);

    expect(v.text).not.toBe("—");
  });
});
