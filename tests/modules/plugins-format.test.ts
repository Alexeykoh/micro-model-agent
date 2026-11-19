import { describe, it, expect, afterEach } from "vitest";
import { formatPluginList } from "../../src/modules/plugins/format";
import { setLocale } from "../../src/i18n/index";

/**
 * `/plugins` при живых встроенных плагинах писал «Плагины не загружены», хотя
 * `/doctor` видел `10 active / 10 total`. Пустой список внешних — не пустой
 * список плагинов.
 */

afterEach(() => setLocale("en"));

describe("formatPluginList: нет внешних, но есть встроенные", () => {
  it("ru: говорит про отсутствие сторонних, а не «не загружены»", () => {
    setLocale("ru");
    const text = formatPluginList([], [], { hiddenHint: 10 }).join("\n");
    expect(text).toContain("Сторонних плагинов нет");
    expect(text).not.toContain("Плагины не загружены");
    expect(text).toContain("10");
  });

  it("en: no third-party plugins", () => {
    const text = formatPluginList([], [], { hiddenHint: 2 }).join("\n");
    expect(text).toContain("No third-party plugins");
    expect(text).toContain("2");
  });

  it("совсем пусто — форматтер молчит, вызывающий печатает cli.plugins.none", () => {
    expect(formatPluginList([], [], { hiddenHint: 0 })).toEqual([]);
  });
});
