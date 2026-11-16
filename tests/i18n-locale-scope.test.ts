/**
 * W9: локаль запроса (спека §13). `X-Mma-Locale` — свойство клиента; сервер
 * исполняет обработчик в ALS-скоупе, не меняя процесс-глобальную локаль.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getLocale, runWithLocale, setLocale, t } from "../src/i18n/index";

afterEach(() => {
  setLocale("en");
});

describe("request locale scope (W9)", () => {
  it("resolves strings in the request locale and restores the process locale", () => {
    setLocale("en");
    expect(t("daemon.busy")).toContain("queued");

    const inside = runWithLocale("ru", () => ({ text: t("daemon.busy"), locale: getLocale() }));
    expect(inside.locale).toBe("ru");
    expect(inside.text).toContain("очеред");

    expect(getLocale()).toBe("en");
    expect(t("daemon.busy")).toContain("queued");
  });

  it("keeps concurrent scopes apart", async () => {
    setLocale("en");
    const [ru, en] = await Promise.all([
      runWithLocale("ru", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return t("daemon.busy");
      }),
      runWithLocale("en", async () => {
        await new Promise((r) => setTimeout(r, 1));
        return t("daemon.busy");
      }),
    ]);

    expect(ru).toContain("очеред");
    expect(en).toContain("queued");
    expect(getLocale()).toBe("en");
  });

  it("ignores an unknown locale instead of blanking the UI", () => {
    setLocale("en");
    expect(runWithLocale("de", () => t("daemon.busy"))).toContain("queued");
    expect(runWithLocale(undefined, () => getLocale())).toBe("en");
  });
});
