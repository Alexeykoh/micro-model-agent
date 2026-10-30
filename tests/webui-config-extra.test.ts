import { describe, expect, it } from "vitest";
import { buildConfigRegistry } from "../src/modules/webui/settings/config-api";
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

  it("covers new keys in web settings sections", async () => {
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
    for (const p of ["persistence", "retry", "lists", "advanced-json"]) {
      expect(a.html).not.toContain(`data-panel="${p}"`);
    }
    // Deep settings live in named sections inside their owning panel.
    const { readFileSync } = await import("node:fs");
    const controls = readFileSync(
      new URL("../src/modules/webui/assets/js/settings/controls.ts", import.meta.url),
      "utf-8",
    );
    for (const k of [
      "retry.maxRetries",
      "browser.headless",
      "session.autoName",
      "webSearch.enabled",
      "tools.defaultTags",
      "security.bash.blacklist",
      "pricing.overrides",
      "modelCapabilities",
      "experts",
    ]) {
      expect(controls).toContain(`"${k}"`);
    }
    for (const p of ["general", "model", "context", "reasoning", "agent", "network", "browser", "sessions", "security", "advanced"]) {
      expect(a.html).toContain(`data-panel="${p}"`);
    }
  });

  it("places every registry key in exactly one settings panel", async () => {
    // A key with no home is config a user can only reach by editing JSON; the
    // reverse (a key in two panels) makes "where does X live" ambiguous.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../src/modules/webui/assets/js/settings/controls.ts", import.meta.url),
      "utf-8",
    );
    const blocks = [...src.matchAll(/keys:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
    const seen = new Map<string, number>();
    for (const block of blocks) {
      for (const m of block.matchAll(/"([a-zA-Z][a-zA-Z0-9_.]*)"/g)) {
        const key = m[1];
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    expect(duplicated).toEqual([]);
    // `model` / `provider.active` are rendered by the bespoke Model panel,
    // `ui.theme*` — by the bespoke theme card (`theme-panel.ts`) above the
    // generated UI sections.
    const bespoke = new Set(["model", "provider.active", "ui.theme", "ui.themeMode"]);
    const unplaced = buildConfigRegistry()
      .map((e) => e.key)
      .filter((k) => !seen.has(k) && !bespoke.has(k));
    expect(unplaced).toEqual([]);
  });

  it("offers only updater keys that actually do something", async () => {
    // Every `updater.*` toggle in this panel was dead while `mma web` skipped the
    // updater, and `checkOnStart` was dead everywhere. A toggle the UI shows but
    // nothing reads is worse than no toggle.
    const { readFileSync } = await import("node:fs");
    const controls = readFileSync(
      new URL("../src/modules/webui/assets/js/settings/controls.ts", import.meta.url),
      "utf-8",
    );
    expect(controls).not.toContain("updater.checkOnStart");
    const updaterKeys = buildConfigRegistry().map((e) => e.key).filter((k) => k.startsWith("updater."));
    expect(updaterKeys.sort()).toEqual(["updater.autoInstall", "updater.enabled", "updater.intervalMs"]);
    for (const key of updaterKeys) expect(controls).toContain(key);
  });

  it("keeps no orphan i18n labels for the retired updater flag", async () => {
    const { readFileSync } = await import("node:fs");
    for (const loc of ["en", "ru"]) {
      const dict = readFileSync(new URL(`../src/i18n/${loc}.json`, import.meta.url), "utf-8");
      expect(dict).not.toContain("updater.checkOnStart");
    }
  });
});
