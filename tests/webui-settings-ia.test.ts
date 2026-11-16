// Settings information architecture: a key lives where its domain does.
// Guards the 0.26 settings cleanup against drift back into "all in one tab".
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { setupHappyDom } from "./helpers/happy-dom";

setupHappyDom("");
const { PANEL_SECTIONS, keyToPanel } = await import(
  "../src/modules/webui/assets/js/settings/controls.js"
);
const i18n = await import("../src/modules/webui/assets/js/i18n.js");
const readDict = (name: string): Record<string, string> =>
  JSON.parse(readFileSync(new URL(`../src/i18n/${name}.json`, import.meta.url), "utf8"));
i18n.I18N.locale = "en";
i18n.I18N.dicts = { en: readDict("en"), ru: readDict("ru") };
const { t } = i18n;

const keysOf = (panel: string): string[] =>
  (PANEL_SECTIONS[panel] || []).flatMap((s: { keys: string[] }) => s.keys);

describe("settings IA", () => {
  it("keeps provider fallback in the model panel, not General", () => {
    expect(keysOf("general")).not.toContain("provider.fallback");
    expect(keysOf("model")).toContain("provider.fallback");
    expect(keyToPanel().get("provider.fallback")).toBe("model");
  });

  it("keeps memory rules in Memory, not Agent/Tools", () => {
    for (const key of [
      "memory.validator",
      "memory.validator.minChars",
      "memory.validator.minWords",
      "memory.validator.similarityThreshold",
      "memory.retentionDays",
    ]) {
      expect(keysOf("memory")).toContain(key);
      expect(keysOf("agent")).not.toContain(key);
      expect(keyToPanel().get(key)).toBe("memory");
    }
  });

  it("keeps HITL/compliance in Security, not Agent/Tools", () => {
    for (const key of [
      "hitl.killSwitch",
      "hitl.autoApproveLow",
      "compliance.enabled",
      "compliance.retentionDays",
    ]) {
      expect(keysOf("security")).toContain(key);
      expect(keysOf("agent")).not.toContain(key);
      expect(keyToPanel().get(key)).toBe("security");
    }
  });

  it("gives Agent Service API its own panel", () => {
    expect(keysOf("service")).toContain("service.port");
    expect(keysOf("service")).toContain("service.tls.key");
    expect(keysOf("network")).not.toContain("service.port");
    expect(keyToPanel().get("service.port")).toBe("service");
  });

  it("does not repeat the version in Advanced", () => {
    expect(keysOf("advanced")).not.toContain("version");
  });

  it("keeps the raw plugin skip list out of the Plugins tab", () => {
    expect(keysOf("plugins")).toContain("plugins.maxDrafts");
    expect(keysOf("plugins")).not.toContain("plugins.disabled");
    expect(keysOf("advanced")).toContain("plugins.disabled");
    expect(keyToPanel().get("plugins.disabled")).toBe("advanced");
  });

  it("localizes every new tab/section label", () => {
    for (const key of [
      "web.settings.service",
      "web.settings.sec.model.fallback",
      "web.settings.sec.memory.rules",
      "web.settings.sec.security.approvals",
      "web.settings.sec.advanced.service",
    ]) {
      expect(t(key)).not.toBe(key);
    }
  });
});
