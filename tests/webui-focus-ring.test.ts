/**
 * U1 (UX-аудит 2026-11-02): у поля ввода обязан быть видимый индикатор фокуса.
 * U2 (2026-11-03): но без «рамки/свечения» — 2px кольцо `--input-shadow` вокруг
 * composer читалось как подсвеченный бокс и раздражало. Контракт: фокус в
 * console-теме виден сменой цвета 1px-рамки и НЕ рисует мягкое кольцо.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const CONSOLE_CSS = join(process.cwd(), "src", "modules", "webui", "assets", "console.css");

const css = readFileSync(CONSOLE_CSS, "utf-8");

/** Тело правила `body.console .composer:focus-within … { … }`; null — нет правила. */
function focusRuleBody(): string | null {
  const m = /body\.console \.composer:focus-within[\s\S]*?\{([^}]*)\}/.exec(css);
  return m ? m[1] : null;
}

/** Значение токена в блоке `body.console { … }` (одна тема, без `.light`). */
function token(name: string): string | null {
  const m = /body\.console \{([^}]*)\}/.exec(css);
  if (!m) return null;
  const v = new RegExp(`${name}:\\s*([^;]+);`).exec(m[1]);
  return v ? v[1].trim() : null;
}

describe("composer focus indicator (U1)", () => {
  it("console marks focus with a border colour, not a glowing ring", () => {
    const body = focusRuleBody();
    expect(body).not.toBeNull();
    expect(body).toMatch(/border-color:\s*var\(--inp-focus\)/);
    expect(body).not.toMatch(/box-shadow/);
  });

  it("focus border is distinguishable from the resting border", () => {
    const focus = token("--inp-focus");
    const rest = token("--inp-border");
    expect(focus).toBeTruthy();
    expect(rest).toBeTruthy();
    expect(focus).not.toBe(rest);
  });
});
