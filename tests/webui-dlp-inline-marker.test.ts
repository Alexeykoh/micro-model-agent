// DLP-псевдоним внутри аргумента тула — короткая метка класса, а не длинная
// фраза, вклеенная в середину идентификатора: `proc_<PII:…>10_45` не должен
// превращаться в `proc_скрыто политикой данных10_45`.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

setupHappyDom(`<div></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "web.egress.hidden": "hidden by data policy",
    "web.egress.hidden_short": "‹{kind}›",
  },
};

const fmt = await import("../src/modules/webui/assets/js/format.js");

describe("webui: DLP-метка в аргументах тула", () => {
  it("сохраняет контекст вокруг псевдонима", () => {
    expect(fmt.hiddenText("proc_<PII:abc12345>10_45")).toBe("proc_‹PII›10_45");
    expect(fmt.hiddenText("read <PATH:deadbeef>/core/file.ts")).toBe("read ‹PATH›/core/file.ts");
  });

  it("показывает класс псевдонима, включая фолбэк DP", () => {
    expect(fmt.hiddenText("<SECRET:abc12345>")).toBe("‹SECRET›");
    expect(fmt.hiddenText("<DP:abc12345>")).toBe("‹DP›");
  });

  it("не использует длинную фразу как инлайновую замену", () => {
    const out = fmt.hiddenText("x <HOST:abc12345> y");
    expect(out).not.toContain("hidden by data policy");
    expect(out).toBe("x ‹HOST› y");
  });

  it("isHiddenText по-прежнему видит все классы и фолбэк", () => {
    expect(fmt.isHiddenText("<PATH:abc12345>")).toBe(true);
    expect(fmt.isHiddenText("proc_<PII:abc12345>10_45")).toBe(true);
    expect(fmt.isHiddenText("<DP:abc12345>")).toBe(true);
    expect(fmt.isHiddenText("plain text")).toBe(false);
  });

  it("argText не портит идентификатор процесса", () => {
    expect(fmt.argText({ id: "proc_<PII:abc12345>10_45" })).toBe("proc_‹PII›10_45");
  });
});
