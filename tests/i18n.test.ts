import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { t, setLocale, } from "../src/i18n/index";

describe("i18n", () => {
  beforeEach(() => {
    setLocale("en");
  });

  afterEach(() => {
    setLocale("en");
  });

  it("should return key for unknown translation", () => {
    expect(t("unknown.key")).toBe("unknown.key");
  });

  it("should translate simple string", () => {
    const result = t("file.created", { path: "src/index.ts" });
    expect(result).toContain("Created");
    expect(result).toContain("src/index.ts");
  });

  it("should support Russian locale", () => {
    setLocale("ru");
    const result = t("file.created", { path: "src/index.ts" });
    expect(result).toContain("Создан");
    expect(result).toContain("src/index.ts");
  });

  it("should handle error messages", () => {
    expect(t("error.timeout")).toBe("Request timed out");
  });

  it("defines exec.task_reminder in en and ru", () => {
    expect(t("exec.task_reminder", { task: "x" })).not.toBe("exec.task_reminder");
    setLocale("ru");
    expect(t("exec.task_reminder", { task: "x" })).not.toBe("exec.task_reminder");
  });

  it("localizes terminal context-budget part words (ses_mup6p61q F2)", () => {
    // Баннер `(sys/res/hist)` был непереведённой латиницей в обеих локалях.
    expect(t("repl.ctx_part_system")).toBe("system");
    expect(t("repl.ctx_part_reserve")).toBe("reserve");
    expect(t("repl.ctx_part_history")).toBe("history");
    setLocale("ru");
    expect(t("repl.ctx_part_system")).toBe("система");
    expect(t("repl.ctx_part_reserve")).toBe("резерв");
    expect(t("repl.ctx_part_history")).toBe("история");
  });

  it("should fallback to en when locale missing key", () => {
    setLocale("ru");
    const result = t("session.started", { id: "abc" });
    expect(result).toBeTruthy();
  });

  it("every registry key has key+desc labels in en and ru", async () => {
    const { configDefs } = await import("../src/config/registry");
    const { getFlatDicts } = await import("../src/i18n/index");
    const dicts = getFlatDicts();
    for (const def of configDefs()) {
      for (const k of [`config.key.${def.key}`, `config.desc.${def.key}`]) {
        expect(typeof dicts.en[k], `${k} (en)`).toBe("string");
        expect(typeof dicts.ru[k], `${k} (ru)`).toBe("string");
      }
    }
  });
});
