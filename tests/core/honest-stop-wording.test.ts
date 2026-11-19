import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { t, setLocale } from "../../src/i18n/index";

/**
 * S3 (спека 0.25.2): honest-stop больше не запрещает смену подхода. Прежний
 * текст «НЕ пробуй другую команду, флаг или обход» блокировал единственно
 * правильное поведение при недоступном шелле — перейти на файловые тулы.
 */
describe("exec.honest_stop wording (S3)", () => {
  beforeEach(() => setLocale("en"));
  afterEach(() => setLocale("en"));

  it("en: points at a different tool class, not at 'do not try anything'", () => {
    const text = t("exec.honest_stop", { count: "4" });
    expect(text.toLowerCase()).toContain("different class of tools");
    expect(text).toContain("plan_step status=skipped");
    expect(text).not.toContain("Do NOT try another command");
    expect(text).toContain("STOP retrying");
  });

  it("ru: points at a different tool class, not at 'do not try anything'", () => {
    setLocale("ru");
    const text = t("exec.honest_stop", { count: "4" });
    expect(text.toLowerCase()).toContain("другой класс инструментов");
    expect(text).toContain("plan_step status=skipped");
    expect(text).not.toContain("НЕ пробуй другую команду");
    expect(text).toContain("ХВАТИТ повторять");
  });

  it("keeps the count placeholder in both locales", () => {
    expect(t("exec.honest_stop", { count: "7" })).toContain("7");
    setLocale("ru");
    expect(t("exec.honest_stop", { count: "7" })).toContain("7");
  });
});
