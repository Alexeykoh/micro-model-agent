// Русская локаль в веб-поверхности: `/status` не должен отдавать английские
// хвосты, счётчик инструментов обязан склоняться, а код причины из
// `/api/config` (`invalid-value`) — переводиться, а не показываться сырым.
import { describe, it, expect, afterEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";
import { getFlatDicts, setLocale } from "../src/i18n/index";
import { makeHarness } from "./helpers/webui-commands";

describe("/status при locale=ru", () => {
  afterEach(() => setLocale("en"));

  it("не отдаёт английских хвостов про AGENTS.md, карту и сообщения", async () => {
    setLocale("ru");
    const h = makeHarness();
    h.state.workspace = "/tmp/proj";
    h.state.agentsMd = { files: [], disabled: false };
    h.state.projectMapStats = () => ({ files: 4, symbols: 10, tokens: 1200 });

    await h.run("/status");
    const text = h.lines.join("\n");

    expect(text).not.toContain("not found");
    expect(text).not.toContain("file(s)");
    expect(text).not.toContain("msgs");
    expect(text).not.toContain("dir:");

    expect(text).toContain("AGENTS.md: не найден");
    expect(text).toContain("каталог: /tmp/proj");
    expect(text).toContain("карта: файлов 4");
    expect(text).toContain("сообщ.");
  });
});

describe("русские формы в веб-словаре", () => {
  it("web.turn.tools склоняется по числу", async () => {
    setupHappyDom();
    const { I18N, pluralCount } = await import("../src/modules/webui/assets/js/i18n");
    I18N.locale = "ru";
    I18N.dicts = getFlatDicts() as Record<string, Record<string, string>>;

    expect(pluralCount("web.turn.tools", 1)).toBe("1 инструмент");
    expect(pluralCount("web.turn.tools", 2)).toBe("2 инструмента");
    expect(pluralCount("web.turn.tools", 5)).toBe("5 инструментов");
    expect(pluralCount("web.turn.tools", 11)).toBe("11 инструментов");
    expect(pluralCount("web.turn.tools", 21)).toBe("21 инструмент");
  });
});

describe("ошибка сохранения настроек", () => {
  it("переводит код причины вместо сырого `invalid-value`", async () => {
    setupHappyDom();
    const { I18N } = await import("../src/modules/webui/assets/js/i18n");
    const { saveErrorText } = await import("../src/modules/webui/assets/js/settings/save-error");
    I18N.locale = "ru";
    I18N.dicts = getFlatDicts() as Record<string, Record<string, string>>;

    expect(saveErrorText("invalid-value", "ui.fontSize")).toBe(
      "недопустимое значение для ui.fontSize",
    );
    expect(saveErrorText("unknown-key", "nope.key")).toBe("неизвестный ключ: nope.key");
    expect(saveErrorText("read-only", "model")).toBe("model только для чтения");
    // Незнакомый код — это уже текст от сервера, его не трогаем.
    expect(saveErrorText("boom", "model")).toBe("boom");
  });

  it("переводит ошибки `/config` в ленте", async () => {
    setLocale("ru");
    const h = makeHarness();
    await h.run("/config maxToolIterations abc");
    await h.run("/config nope.key");
    await h.run("/config model");
    const text = h.lines.join("\n");
    expect(text).not.toContain("invalid value for");
    expect(text).not.toContain("unknown key");
    expect(text).toContain("недопустимое значение для maxToolIterations");
    expect(text).toContain("неизвестный ключ: nope.key");
  });
});
