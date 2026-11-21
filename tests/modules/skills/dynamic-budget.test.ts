// contextAuto: бюджет скиллов должен следовать окну, подставленному пробой.
import { describe, it, expect } from "vitest";
import { SkillsModule } from "../../../src/modules/skills/module";

describe("dynamic skills budget", () => {
  it("reads the effective context window at load time, not the startup value", () => {
    let contextWindow = 32768;
    const mod = new SkillsModule([], () => Math.floor(contextWindow * 0.15));
    expect(mod.getBudget().total).toBe(4915);

    // Проба модели приземлилась фоном уже после сборки модуля.
    contextWindow = 1048576;
    expect(mod.getBudget().total).toBe(157286);
    expect(mod.getBudget().remaining).toBe(157286);
  });

  it("still accepts a plain number for legacy callers", () => {
    const mod = new SkillsModule([], 1000);
    expect(mod.getBudget()).toEqual({ used: 0, total: 1000, remaining: 1000 });
  });
});
