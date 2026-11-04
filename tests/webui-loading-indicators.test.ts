// A1/A4/A5 (INV-W8/W9, спека 2026-11-04-webui-latency-design): индикация
// загрузки живёт в CSS. Здесь — то, что регрессирует незаметно: скелетон,
// блокировка ввода, спиннер вместо статичного `⋯` и признаки загрузки,
// переживающие `prefers-reduced-motion`.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/modules/webui/assets/styles.css", "utf8");
const mascot = readFileSync("src/modules/webui/assets/js/mascot-canvas.ts", "utf8");

describe("loading indicators (INV-W8/W9)", () => {
  it("has a feed skeleton and a switching state for the composer", () => {
    expect(css).toContain(".feed-skel {");
    expect(css).toContain("@keyframes skelSweep");
    expect(css).toContain(".input-area.switching .composer");
    expect(css).toContain("cursor: progress");
  });

  it("replaces the static pending mark with a spinner and a wait counter", () => {
    expect(css).toContain('content: "◐"');
    expect(css).toMatch(/\.sel > button\.pending b::after \{[^}]*animation: spin/);
    // Счётчик берёт своё значение из `data-wait` — разметку не переписывает.
    expect(css).toContain("content: attr(data-wait)");
  });

  it("keeps loading indicators alive under prefers-reduced-motion", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    // Общее правило гасит анимации, индикаторы — исключение.
    expect(reduced).toContain("animation-duration: .001ms !important");
    for (const selector of [
      ".busy .spin",
      ".feed-skel i",
      ".stab .dot.st-working",
      ".sel > button.pending b::after",
    ]) {
      expect(reduced).toContain(selector);
    }
    expect(reduced).toMatch(/animation-iteration-count: infinite !important/);
    // Глаза лоадера не должны замеряться вместе со всеми `.mdl`.
    expect(css).toContain(".mdl.st-load .eye,");
    expect(css).toContain("animation: mdlWake 3.4s ease-in-out infinite !important");
  });

  it("runs the mascot loop under reduced motion too (A4)", () => {
    // Раньше `start()` не стартовал при `reduce` — лоадер выглядел мёртвым.
    expect(mascot).not.toContain("if (raf || reduced ||");
    expect(mascot).toContain("const REDUCED_FRAME_MS = 100");
    // Пружинный переход позы отключён, но фаза (моргание) продолжает идти.
    expect(mascot).toContain("time: this.time");
    expect(mascot).not.toContain("reduced ? 0.9 : this.time");
    expect(mascot).toContain("const switching = state !== this.state && !reduced;");
  });
});
