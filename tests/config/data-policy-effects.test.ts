import { describe, expect, it } from "vitest";
import { DATA_POLICY_DEFS } from "../../src/config/registry-data-policy";
import { needsRebuild } from "../../src/config/effects";

/**
 * W2: правка `security.dataPolicy.*` из UI/REPL обязана пересобрать провайдера —
 * guard читается при `ProviderManager.build()`, иначе изменение политики
 * применится только после рестарта (дыра в «важнейшем правиле»).
 */
describe("security.dataPolicy.* config effects", () => {
  it("содержит все ключи политики", () => {
    const keys = DATA_POLICY_DEFS.map((d) => d.key);
    expect(keys).toHaveLength(16);
    for (const key of keys) expect(key.startsWith("security.dataPolicy.")).toBe(true);
  });

  it("каждый ключ объявляет provider.rebuild", () => {
    for (const def of DATA_POLICY_DEFS) {
      expect(def.effects, `${def.key} must rebuild the provider`).toContain("provider.rebuild");
      expect(needsRebuild(def.effects), `${def.key} must be live-applied`).toBe(true);
    }
  });
});
