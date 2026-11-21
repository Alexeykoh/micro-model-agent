// RCV-1/6: общая классификация ошибок валидации и честные формулировки директив.
import { describe, it, expect } from "vitest";
import { isValidationFailure } from "../../src/core/agent/validation-failure";
import en from "../../src/i18n/en.json";
import ru from "../../src/i18n/ru.json";

const fail = (output: string) => ({ success: false as const, output });

describe("RCV-1: isValidationFailure", () => {
  it("recognises security blocks and deterministic argument errors", () => {
    expect(isValidationFailure(fail('[SECURITY BLOCKED] Operator ">" is not allowed'))).toBe(true);
    expect(isValidationFailure(fail("Process not found: __p6_8"))).toBe(true);
    expect(isValidationFailure(fail("Plan does not cover files required by the task"))).toBe(true);
    expect(isValidationFailure({ success: false, output: "x", blocked: true })).toBe(true);
    expect(
      isValidationFailure({
        success: false,
        output: "x",
        errorMeta: { code: "BAD", retryable: false },
      }),
    ).toBe(true);
  });

  it("does not excuse real environment failures", () => {
    expect(isValidationFailure(fail("bridge-server.mjs not found: ENOENT"))).toBe(false);
    expect(isValidationFailure(fail("connection refused"))).toBe(false);
  });
});

describe("RCV-6: directives do not tell the model to abandon the task", () => {
  for (const [locale, dict] of [["en", en], ["ru", ru]] as const) {
    it(`${locale}: tool_disabled keeps the task going`, () => {
      const text = (dict as Record<string, string>)["exec.tool_disabled"];
      expect(text).not.toMatch(/stop and tell|Остановись и скажи/i);
      expect(text).toMatch(/continue the task|Продолжай задачу/i);
    });
    it(`${locale}: finalize_no_tools does not call the task impossible`, () => {
      const text = (dict as Record<string, string>)["exec.finalize_no_tools"];
      expect(text).not.toMatch(/Do not request tools or ask to continue|Не запрашивай инструменты/i);
      expect(text).toMatch(/continues in the next turn|продолжается в следующем ходе/i);
    });
  }
});
