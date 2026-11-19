import { describe, it, expect, afterEach } from "vitest";
import { sessionAge } from "../../src/cli/session-age";
import { setLocale } from "../../src/i18n/index";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

afterEach(() => setLocale("en"));

describe("sessionAge: компактный возраст для /sessions", () => {
  it("ru: секунды, минуты, часы, дни", () => {
    setLocale("ru");
    expect(sessionAge(ago(10_000), NOW)).toBe("сейчас");
    expect(sessionAge(ago(5 * 60_000), NOW)).toBe("5м назад");
    expect(sessionAge(ago(3 * 3_600_000), NOW)).toBe("3ч назад");
    expect(sessionAge(ago(2 * 86_400_000), NOW)).toBe("2д назад");
  });

  it("en: единицы на английском", () => {
    expect(sessionAge(ago(10_000), NOW)).toBe("just now");
    expect(sessionAge(ago(5 * 60_000), NOW)).toBe("5m ago");
    expect(sessionAge(ago(3 * 3_600_000), NOW)).toBe("3h ago");
    expect(sessionAge(ago(2 * 86_400_000), NOW)).toBe("2d ago");
  });

  it("старше месяца — дата без года (влезает в шапку)", () => {
    expect(sessionAge("2026-09-15T10:00:00.000Z", NOW)).toBe("09.15");
  });

  it("битая дата — пусто, а не «NaN»", () => {
    expect(sessionAge("not-a-date", NOW)).toBe("");
  });
});
