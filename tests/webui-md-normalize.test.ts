// Нормализация GFM, которую smd.js (CommonMark) оставляет сырым текстом.
import { describe, it, expect } from "vitest";
import { normalizeMarkdown, MdNormalizer } from "../src/modules/webui/assets/js/md-normalize";

describe("normalizeMarkdown", () => {
  it("добавляет внешние `|` таблице без крайних пайпов", () => {
    const out = normalizeMarkdown("A | B\n---|---\n1 | 2\n");
    expect(out).toBe("| A | B |\n| ---|--- |\n| 1 | 2 |\n");
  });

  it("не трогает таблицу с внешними `|`", () => {
    const src = "| A | B |\n|---|---|\n| 1 | 2 |\n";
    expect(normalizeMarkdown(src)).toBe(src);
  });

  it("не считает одиночный `---` таблицей (setext/hr)", () => {
    const src = "a | b\n---\n";
    expect(normalizeMarkdown(src)).toBe(src);
  });

  it("нормализует `1)` и `##X`", () => {
    expect(normalizeMarkdown("1) один\n2) два\n")).toBe("1. один\n2. два\n");
    expect(normalizeMarkdown("##Отчёт\nтекст\n")).toBe("## Отчёт\nтекст\n");
  });

  it("не трогает содержимое код-фенсов", () => {
    const src = "```\nA | B\n---|---\n1) x\n##y\n```\n";
    expect(normalizeMarkdown(src)).toBe(src);
  });

  it("не трогает прозу с `|` без строки-разделителя", () => {
    const src = "Итог: 10 | 20 без таблицы\n";
    expect(normalizeMarkdown(src)).toBe(src);
  });
});

describe("MdNormalizer (streaming)", () => {
  const SRC = "Итог:\nA | B\n---|---\n1 | 2\n\n1) x\n##Y\n```\na|b\n---\n```\n";

  it("даёт тот же результат при произвольных разбиениях чанка", () => {
    const expected = normalizeMarkdown(SRC);
    for (const size of [1, 2, 3, 5, 7, 11]) {
      const n = new MdNormalizer();
      let out = "";
      for (let i = 0; i < SRC.length; i += size) out += n.push(SRC.slice(i, i + size));
      out += n.flush();
      expect(out).toBe(expected);
    }
  });

  it("удерживает недописанную последнюю строку до flush", () => {
    const n = new MdNormalizer();
    // Заголовок таблицы держится, пока не придёт строка-разделитель.
    expect(n.push("A | B\n")).toBe("");
    expect(n.push("---|---\n")).toBe("| A | B |\n");
    const out = n.push("1 | 2\n") + n.flush();
    expect(out).toBe("| ---|--- |\n| 1 | 2 |\n");
  });
});
