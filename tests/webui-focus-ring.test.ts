/**
 * U1 (UX-аудит 2026-11-02): у поля ввода обязан быть видимый индикатор фокуса.
 * Контракт: темы не могут задавать `--input-shadow` прозрачным — иначе кольцо
 * фокуса (`box-shadow: 0 0 0 2px var(--input-shadow)`) невидимо, а у `.inp`
 * ещё и `outline: none`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const CONSOLE_CSS = join(
  process.cwd(),
  "src",
  "modules",
  "webui",
  "assets",
  "console.css",
);

/** Непрозрачность `#RRGGBBAA` (0..255); null — не hex8. */
function alphaOf(value: string): number | null {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(value.trim());
  return m ? Number.parseInt(m[2], 16) : null;
}

describe("composer focus ring (U1)", () => {
  it("no theme makes --input-shadow transparent", () => {
    const css = readFileSync(CONSOLE_CSS, "utf-8");
    const values = [...css.matchAll(/--input-shadow:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value.toLowerCase()).not.toBe("transparent");
      expect(value).not.toMatch(/rgba\([^)]*,\s*0\s*\)$/);
    }
  });

  it("the ring is visible enough to notice (alpha >= 30%)", () => {
    const css = readFileSync(CONSOLE_CSS, "utf-8");
    const values = [...css.matchAll(/--input-shadow:\s*([^;]+);/g)].map((m) => m[1].trim());
    for (const value of values) {
      const alpha = alphaOf(value);
      // Не-hex8 формат допустим (например, color-mix) — проверяем только
      // явные hex8, где отсутствие альфы нельзя оправдать.
      if (alpha !== null) expect(alpha).toBeGreaterThanOrEqual(0x4d);
    }
  });
});
