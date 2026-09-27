import { describe, expect, it } from "vitest";
import { buildConfigRegistry } from "../src/modules/webui/config-api";
import { loadAssets } from "../src/modules/webui/assets";

// NOTE (Task 6): registry Tasks 3-4 already merged, so the backend half of
// this test passes pre-change and acts as a behavior lock. The frontend half
// (SECTION_KEYS coverage in the served bundle) FAILS pre-change — that is the
// red this task turns green.
describe("web config registry extras", () => {
  it("exposes new keys with bounds", () => {
    const reg = buildConfigRegistry();
    expect(reg.length).toBeGreaterThan(90);
    const keys = reg.map((e) => e.key);
    for (const k of [
      "autoPlan",
      "browser.headless",
      "security.bash.blacklist",
      "pricing.overrides",
      "reasoning.min",
      "contextLog.enabled",
    ]) {
      expect(keys).toContain(k);
    }
    const ctx = reg.find((e) => e.key === "contextWindow")!;
    expect(ctx.min).toBe(1024);
  });

  it("covers new keys in web settings sections", () => {
    const a = loadAssets();
    const js = [a.js, ...Object.values(a.jsModules ?? {})].join("\n");
    for (const k of [
      "autoPlan",
      "provider.fallback",
      "contextBudget.compactionMinLoad",
      "contextLog.enabled",
      "reasoning.min",
      "reasoning.baseline",
      "tools.enableOnDemand",
      "skills.budget",
      "subagent.resultMode",
      "webSearch.enabled",
      "browser.headless",
      "session.autoName",
      "retry.maxRetries",
      "tools.defaultTags",
      "security.bash.blacklist",
      "pricing.overrides",
      "modelCapabilities",
      "experts",
    ]) {
      expect(js).toContain(`"${k}"`);
    }
    for (const p of ["network", "browser", "persistence", "retry", "lists", "advanced-json"]) {
      expect(a.html).toContain(`data-panel="${p}"`);
    }
  });
});
