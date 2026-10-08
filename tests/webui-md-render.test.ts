// Рендер финального ответа: GFM-нормализация не должна оставлять сырых маркеров.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";
import { renderMarkdown } from "../src/modules/webui/assets/md";

beforeEach(() => {
  const win = setupHappyDom();
  (globalThis as unknown as Record<string, unknown>).DOMParser = (win as unknown as Record<string, unknown>).DOMParser;
});

describe("renderMarkdown", () => {
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
