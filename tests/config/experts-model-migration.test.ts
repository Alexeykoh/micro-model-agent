/**
 * Миграция персиста `experts[*].model`: снимается только устаревший
 * авто-дефолтный пин (`qwen/qwen3.5-9b`), пользовательский выбор и
 * `provider` без модели остаются как есть.
 *
 * Спека `2026-11-01-experts-model-selection-design`, INV-E4.
 */
import { describe, it, expect } from "vitest";
import {
  LEGACY_EXPERT_DEFAULT_MODEL,
  migratePersistedExpertModels,
} from "../../src/config/migrate-legacy";
import { DEFAULTS } from "../../src/config/defaults";

describe("migratePersistedExpertModels", () => {
  it("drops the legacy default pin and keeps a user-chosen model", () => {
    const raw = {
      experts: {
        code: { model: LEGACY_EXPERT_DEFAULT_MODEL, tool_tags: ["file"] },
        research: { model: "custom/model", tool_tags: ["research"] },
      },
    };
    const state = migratePersistedExpertModels(raw);
    expect(state.migrated).toBe(true);
    expect(state.tags).toEqual(["code"]);
    expect(raw.experts.code).not.toHaveProperty("model");
    expect(raw.experts.research.model).toBe("custom/model");
  });

  it("keeps the legacy pin when a provider is set (mute option must stay visible)", () => {
    const raw = {
      experts: {
        code: { model: LEGACY_EXPERT_DEFAULT_MODEL, provider: "remote", tool_tags: ["file"] },
      },
    };
    const state = migratePersistedExpertModels(raw);
    expect(state.migrated).toBe(false);
    expect(raw.experts.code.model).toBe(LEGACY_EXPERT_DEFAULT_MODEL);
  });

  it("is idempotent: a second pass changes nothing", () => {
    const raw = { experts: { code: { model: LEGACY_EXPERT_DEFAULT_MODEL, tool_tags: ["file"] } } };
    expect(migratePersistedExpertModels(raw).migrated).toBe(true);
    expect(migratePersistedExpertModels(raw).migrated).toBe(false);
  });

  it("tolerates an empty / missing experts block", () => {
    expect(migratePersistedExpertModels(undefined).migrated).toBe(false);
    expect(migratePersistedExpertModels({}).migrated).toBe(false);
  });

  it("defaults no longer pin a model", () => {
    for (const expert of Object.values(DEFAULTS.experts)) {
      expect(expert.model).toBeUndefined();
    }
  });
});
