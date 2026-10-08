import { describe, it, expect } from "vitest";
import {
  checkExpertModels,
  applyExpertModelCheck,
  describeExpertModelReplacement,
} from "../../../src/modules/execution/expert-model-check";
import { DEFAULTS } from "../../../src/config/defaults";
import type { AppConfig } from "../../../src/config/types";

/** Конфиг с экспертами на несуществующей у провайдера модели (случай из сессии). */
function configWithExperts(models: Record<string, string>): AppConfig {
  const config = structuredClone(DEFAULTS);
  config.model = "qwen3.8-9b-distill";
  config.experts = {
    research: { model: models.research ?? "", tool_tags: ["research"] },
    code: { model: models.code ?? "", tool_tags: ["file", "code"] },
  };
  return config;
}

describe("checkExpertModels", () => {
  it("replaces an expert model the active provider does not serve", () => {
    const config = configWithExperts({ research: "qwen/qwen3.5-9b" });
    const check = checkExpertModels(config, ["qwen3.8-9b-distill"]);

    expect(check.replaced).toEqual({ research: "qwen/qwen3.5-9b" });
    expect(check.models.research).toBe("qwen3.8-9b-distill");
    // Тег без модели и модель, совпадающая с активной, не трогаем.
    expect(check.replaced.code).toBeUndefined();
  });

  it("keeps a model the provider serves", () => {
    const config = configWithExperts({ research: "qwen3.8-9b-distill" });
    const check = checkExpertModels(config, ["qwen3.8-9b-distill"]);
    expect(check.replaced).toEqual({});
    expect(check.models.research).toBe("qwen3.8-9b-distill");
  });

  it("skips the check when the model list is unknown (fail-open)", () => {
    const config = configWithExperts({ research: "qwen/qwen3.5-9b" });
    expect(checkExpertModels(config, null).replaced).toEqual({});
    expect(checkExpertModels(config, []).replaced).toEqual({});
  });

  it("matches models with surrounding whitespace", () => {
    const config = configWithExperts({ research: " qwen3.8-9b-distill " });
    const check = checkExpertModels(config, ["qwen3.8-9b-distill"]);
    expect(check.replaced).toEqual({});
  });
});

describe("applyExpertModelCheck", () => {
  it("returns a config copy with fixed models and leaves the live config intact", () => {
    const config = configWithExperts({ research: "qwen/qwen3.5-9b" });
    const check = checkExpertModels(config, ["qwen3.8-9b-distill"]);
    const fixed = applyExpertModelCheck(config, check);

    expect(fixed).not.toBe(config);
    expect(fixed.experts.research.model).toBe("qwen3.8-9b-distill");
    // Пользователь должен видеть свою (неверную) настройку в /config.
    expect(config.experts.research.model).toBe("qwen/qwen3.5-9b");
  });

  it("returns the same object when nothing was replaced", () => {
    const config = configWithExperts({ research: "qwen3.8-9b-distill" });
    const check = checkExpertModels(config, ["qwen3.8-9b-distill"]);
    expect(applyExpertModelCheck(config, check)).toBe(config);
  });
});

describe("describeExpertModelReplacement", () => {
  it("names the tag, the bad model and the fallback", () => {
    const text = describeExpertModelReplacement(
      { research: "qwen/qwen3.5-9b" },
      "qwen3.8-9b-distill",
      ["qwen3.8-9b-distill"],
    );
    expect(text).toContain("research");
    expect(text).toContain("qwen/qwen3.5-9b");
    expect(text).toContain("qwen3.8-9b-distill");
  });
});
