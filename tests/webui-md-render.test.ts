// Рендер финального ответа: GFM-нормализация не должна оставлять сырых маркеров.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";
import { renderMarkdown } from "../src/modules/webui/assets/md";

beforeEach(() => {
  const win = setupHappyDom();
  (globalThis as unknown as Record<string, unknown>).DOMParser = (win as unknown as Record<string, unknown>).DOMParser;
});

describe("renderMarkdown", () => {
  it("не грузит внешние картинки: вместо <img> — ссылка-чип (U2)", () => {
    const el = renderMarkdown(
      document.createElement("div"),
      "![build](https://img.shields.io/badge/build-passing-green)",
    );
    expect(el.querySelector("img")).toBeNull();
    const link = el.querySelector("a.md-img-ext");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://img.shields.io/badge/build-passing-green");
    expect(link?.textContent).toContain("build");
  });

  it("свои картинки (same-origin) и data:image остаются <img>", () => {
    const own = renderMarkdown(document.createElement("div"), "![shot](/api/file?path=a.png)");
    expect(own.querySelector("img")?.getAttribute("src")).toContain("/api/file");
    const data = renderMarkdown(
      document.createElement("div"),
      "![x](data:image/png;base64,AAAA)",
    );
    expect(data.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\//);
  });

  it("рендерит таблицу без крайних пайпов настоящей таблицей", () => {
    const el = renderMarkdown(document.createElement("div"), "A | B\n---|---\n1 | 2\n");
    expect(el.querySelector("table")).not.toBeNull();
    expect(el.querySelectorAll("th")).toHaveLength(2);
    expect(el.querySelectorAll("td")).toHaveLength(2);
    expect(el.textContent || "").not.toContain("|");
    expect(el.textContent || "").not.toContain("---");
  });

  it("рендерит `##X` как заголовок и `1)` как список", () => {
    const el = renderMarkdown(document.createElement("div"), "##Отчёт\n\n1) один\n2) два\n");
    expect(el.querySelector("h2")?.textContent).toBe("Отчёт");
    expect(el.querySelectorAll("ol > li")).toHaveLength(2);
    expect(el.textContent || "").not.toContain("##");
  });

  it("не ломает таблицу с пайпами и код-фенс", () => {
    const src = "| A | B |\n|---|---|\n| 1 | 2 |\n\n```\nA | B\n---\n```\n";
    const el = renderMarkdown(document.createElement("div"), src);
    expect(el.querySelector("table")).not.toBeNull();
    expect(el.querySelector("pre code")?.textContent).toContain("A | B");
    expect(el.querySelector("pre code")?.textContent).toContain("---");
  });
});
