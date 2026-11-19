// Static guard: `@path`-упоминания в композере получают акцентное
// подчёркивание поверх существующей заливки-пилюли (спека
// `2026-11-11-webui-skills-indicator-design.md` §4).
//
// Зеркало рисует подчёркивание слоем под реальным текстом textarea
// (text-decoration-color независим от color: transparent), а заливка
// сохраняется — «подчёркивание + заливка».
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/modules/webui/assets/styles.css", "utf8");

describe("composer mention accent", () => {
  it("keeps the accent-bg pill fill for @mentions", () => {
    expect(css).toMatch(/\.inp-mark \.mmark \{[^}]*background:\s*var\(--accent-bg\)/);
  });

  it("adds an accent-colored underline on @mentions", () => {
    expect(css).toMatch(/\.inp-mark \.mmark \{[^}]*text-decoration:\s*underline/);
    expect(css).toMatch(/\.inp-mark \.mmark \{[^}]*text-decoration-color:\s*var\(--accent\)/);
  });
});