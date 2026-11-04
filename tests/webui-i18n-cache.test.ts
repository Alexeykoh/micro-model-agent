// Pre-paint locale mirror: the boot reads the last `/api/i18n` payload from
// localStorage, so a reload never flashes EN before the saved RU UI.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom("");
win.localStorage.setItem(
  "mma-i18n",
  JSON.stringify({ locale: "ru", dicts: { ru: { "web.env.dir": "директория" }, en: {} } }),
);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");

describe("i18n cache mirror", () => {
  it("hydrates the locale and dictionary from the cache", () => {
    // The module may already be imported by another test file in the same
    // process, so call the hydrator explicitly (it is what the boot does).
    expect(i18n.hydrateI18nCache()).toBe(true);
    expect(i18n.I18N.locale).toBe("ru");
    expect(i18n.hasCachedI18n()).toBe(true);
    expect(i18n.t("web.env.dir")).toBe("директория");
  });

  it("ignores a broken cache instead of throwing", () => {
    win.localStorage.setItem("mma-i18n", "{not json");
    i18n.I18N.locale = "en";
    i18n.I18N.dicts = {};
    expect(i18n.hydrateI18nCache()).toBe(false);
    expect(i18n.hasCachedI18n()).toBe(false);
  });
});
