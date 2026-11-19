import { describe, it, expect, afterEach } from "vitest";
import { criticDegradeLine } from "../src/core/agent/critic-degrade-line";
import { setLocale } from "../src/i18n/index";

/**
 * Формулировка ленты: «проверка не состоялась · таймаут проверки» повторяла
 * подлежащее дважды и читалась как сбой проверки проверки. Причина должна
 * называть класс отказа, а не пересказывать префикс.
 */

afterEach(() => setLocale("en"));

describe("feed wording: critic degrade", () => {
  it("ru: причина таймаута не повторяет «проверка»", () => {
    setLocale("ru");
    const line = criticDegradeLine("call_timeout (125000ms)");
    expect(line).toContain("таймаут");
    expect(line.match(/проверк/gi) ?? []).toHaveLength(1);
  });

  it("en: timeout does not repeat 'verification'", () => {
    const line = criticDegradeLine("call_timeout (125000ms)");
    expect(line).toContain("timed out");
    expect(line.match(/verif/gi) ?? []).toHaveLength(1);
  });
});
