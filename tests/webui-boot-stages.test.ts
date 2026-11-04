// A3 (INV-W9, спека 2026-11-04-webui-latency-design): boot показывает реальную
// стадию и заполнение, а маска остаётся маской — кап продлевается стадиями и
// всё равно гаснет через 2 с тишины (инвариант B-31).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(p, "utf8");
const app = read("src/modules/webui/assets/app.ts");
const html = read("src/modules/webui/assets/index.html");
const css = read("src/modules/webui/assets/styles.css");
const i18nEn = read("src/i18n/en.json");
const i18nRu = read("src/i18n/ru.json");

describe("boot splash reports stages (A3)", () => {
  it("arms the 2 s cap before the setup probe and refreshes it on every stage", () => {
    const arm = app.indexOf("window.setTimeout(hideBootSplash, 2000)");
    const probe = app.indexOf("MmaSetup.maybeOpen");
    expect(arm).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(probe);
    // Кап сбрасывается стадией: живой boot держит маску, зависший — нет.
    expect(app).toContain("function refreshSplashCap(): void");
    expect(app).toContain("refreshSplashCap();");
  });

  it("calls a stage before every slow boot step", () => {
    const stages = [
      "web.loader.step.config",
      "web.loader.step.models",
      "web.loader.step.providers",
      "web.loader.step.sessions",
      "web.loader.step.plugins",
      "web.loader.step.workspace",
    ];
    for (const key of stages) {
      expect(app).toContain(`bootStage("${key}"`);
      expect(i18nEn).toContain(key);
      expect(i18nRu).toContain(key);
    }
    // Стадия должна идти ДО сетевого шага, а не после.
    expect(app.indexOf('bootStage("web.loader.step.config"')).toBeLessThan(
      app.indexOf("await loadConfig()"),
    );
    expect(app.indexOf('bootStage("web.loader.step.sessions"')).toBeLessThan(
      app.indexOf("await loadSessions()"),
    );
  });

  it("stages the caption so a locale switch does not reset it", () => {
    expect(app).toContain("cap.dataset.stage = key");
    const i18n = read("src/modules/webui/assets/app-i18n.ts");
    expect(i18n).toContain("!bootCap.dataset.stage");
  });

  it("drives the progress bar from --p, not from a static 40%", () => {
    expect(app).toContain('?.style.setProperty("--p"');
    expect(css).toContain("width: var(--p, 40%)");
    // Детерминированная полоса вместо бесконечного бегущего блока.
    expect(css).not.toContain("@keyframes mdlBar");
    expect(css).toContain("transition: width .35s ease");
    expect(html).toContain("}, 12000)");
    expect(html).toContain("Hard failsafe");
  });
});
