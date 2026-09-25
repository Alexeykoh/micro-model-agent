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

  it("should fallback to en when locale missing key", () => {
    setLocale("ru");
    const result = t("session.started", { id: "abc" });
    expect(result).toBeTruthy();
  });
});
