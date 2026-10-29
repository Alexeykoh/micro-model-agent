// Guard (B-31): boot-splash — маска, а не гейт. Он не должен держать клики
// дольше 2 с; дальше данные догружаются прогрессивно.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("boot splash не блокирует дольше 2 с", () => {
  it("в boot() есть таймер скрытия, а .hide снимает pointer-events", () => {
    const app = readFileSync("src/modules/webui/assets/app.ts", "utf8");
    expect(app).toContain("setTimeout(hideBootSplash, 2000)");

    const css = readFileSync("src/modules/webui/assets/styles.css", "utf8");
    expect(css).toMatch(/#bootSplash\.hide\s*\{[^}]*pointer-events:\s*none/);
  });
});
