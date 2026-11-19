/**
 * Каталог команд обязан следовать текущей локали. Раньше `t(...)` вычислялся при
 * импорте `spec.ts` — до `setLocale()` в `main()`, поэтому `/help` и комплитер
 * навсегда оставались на английском при `locale: ru`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { buildCommandCatalog } from "../../src/core/commands/spec";
import { setLocale } from "../../src/i18n/index";

const CYRILLIC = /[А-Яа-яЁё]/;

afterEach(() => setLocale("en"));

describe("каталог команд следует локали", () => {
  it("на ru описание и usage переведены", () => {
    setLocale("ru");
    const help = buildCommandCatalog().find((c) => c.name === "help");
    expect(help).toBeDefined();
    expect(help?.description).toMatch(CYRILLIC);
    expect(help?.usage).toMatch(CYRILLIC);
  });

  it("переключение локали перерисовывает тот же каталог", () => {
    setLocale("ru");
    const ru = buildCommandCatalog().find((c) => c.name === "status")?.description;
    setLocale("en");
    const en = buildCommandCatalog().find((c) => c.name === "status")?.description;
    expect(ru).toBeTruthy();
    expect(en).toBeTruthy();
    expect(ru).not.toBe(en);
  });
});
