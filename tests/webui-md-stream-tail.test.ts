// Живой хвост стримингового Markdown: незакоммиченный текст обязан быть виден
// в DOM уже во время стрима, а не только после `end()`.
//
// Дефект P0 (браузерный прогон 2026-10-23): `MdNormalizer.push()` отдаёт только
// завершённые строки, `flush()` — лишь на `end()`; однострочный ответ целиком
// копился в `buf`, поэтому `.md.streaming` оставался пустым весь ход.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";
import { mountMarkdown } from "../src/modules/webui/assets/md";
import { MdNormalizer } from "../src/modules/webui/assets/js/md-normalize";

describe("MdNormalizer.pending()", () => {
  it("отдаёт незакоммиченный хвост, не меняя состояние нормализатора", () => {
    const n = new MdNormalizer();
    expect(n.pending()).toBe("");
    expect(n.push("TypeScript добавляет типы")).toBe("");
    expect(n.pending()).toBe("TypeScript добавляет типы");
    // Хвост не «съедает» строку: строка уходит в flush целиком, без дубля.
    expect(n.push(" в JS\n")).toBe("");
    expect(n.pending()).toBe("TypeScript добавляет типы в JS");
    expect(n.flush()).toBe("TypeScript добавляет типы в JS\n");
    expect(n.pending()).toBe("");
  });

  it("показывает кандидата в таблицу, по-прежнему держа его до lookahead", () => {
    const n = new MdNormalizer();
    expect(n.push("A | B\n")).toBe("");
    expect(n.pending()).toBe("A | B");
    expect(n.push("---|---\n")).toBe("| A | B |\n");
    expect(n.pending()).toBe("---|---");
  });

  it("не выдаёт висящий перевод строки, когда незакоммиченного ничего нет", () => {
    const n = new MdNormalizer();
    n.push("строка\n");
    // `held` уже решён в `flush`, `buf` пуст — хвоста нет.
    expect(n.flush()).toBe("строка\n");
    expect(n.pending()).toBe("");
  });
});

describe("mountMarkdown: живой хвост в DOM", () => {
  it("показывает незавершённую строку до end()", () => {
    setupHappyDom();
    const parent = document.createElement("div");
    const h = mountMarkdown(parent);
    h.write("TypeScript добавляет типы");
    expect(parent.textContent).toContain("TypeScript добавляет типы");
    h.write(" в JS\n");
    h.end();
    const txt = parent.textContent || "";
    expect(txt).toBe("TypeScript добавляет типы в JS");
    expect(parent.querySelectorAll(".md-tail").length).toBe(0);
  });

  it("показывает хвост многострочного ответа во время стрима", () => {
    setupHappyDom();
    const parent = document.createElement("div");
    const h = mountMarkdown(parent);
    h.write("Первая строка\n");
    h.write("Вторая стр");
    expect(parent.textContent).toContain("Первая строка");
    expect(parent.textContent).toContain("Вторая стр");
    h.write("ока\n");
    h.end();
    const txt = parent.textContent || "";
    expect(txt).toContain("Первая строка");
    expect(txt).toContain("Вторая строка");
    expect(txt.indexOf("Первая")).toBe(txt.lastIndexOf("Первая"));
    expect(parent.querySelectorAll(".md-tail").length).toBe(0);
  });

  it("кладёт хвост внутрь текущего контейнера, а не рядом с ним", () => {
    setupHappyDom();
    const parent = document.createElement("div");
    const h = mountMarkdown(parent);
    h.write("один\n");
    h.write("два\n");
    h.write("три");
    const tail = parent.querySelector(".md-tail");
    expect(tail).toBeTruthy();
    // Хвост живёт внутри того узла, куда smd допишет следующую строку:
    // иначе текст прыгает между блоками при коммите.
    expect(tail?.closest("p")).toBeTruthy();
    h.end();
    expect(parent.querySelectorAll(".md-tail").length).toBe(0);
  });

  it("не ломает код-блок: хвост идёт внутри <code>", () => {
    setupHappyDom();
    const parent = document.createElement("div");
    const h = mountMarkdown(parent);
    h.write("```ts\n");
    h.write("const a = 1;\n");
    h.write("const b = ");
    const tail = parent.querySelector(".md-tail");
    expect(tail).toBeTruthy();
    expect(tail?.closest("code")).toBeTruthy();
    expect(parent.textContent).toContain("const a = 1;");
    expect(parent.textContent).toContain("const b =");
    h.write("2;\n```\n");
    h.end();
    const txt = parent.textContent || "";
    expect(txt).toContain("const a = 1;");
    expect(txt).toContain("const b = 2;");
    expect(txt.indexOf("const a")).toBe(txt.lastIndexOf("const a"));
  });
});
