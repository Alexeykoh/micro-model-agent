import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

setupHappyDom();

const { buildModelCapabilities } = await import(
  "../src/modules/webui/assets/js/settings/model-capabilities-form.js"
);

describe("model capabilities form value", () => {
  const all = {
    "other-model": { vision: true },
    "bonsai-2-27b-pq2": { tools: false },
  };

  it("replaces only the edited model and drops unset fields", () => {
    const out = buildModelCapabilities(all, "bonsai-2-27b-pq2", {
      vision: true,
      reasoningStrategy: "openai-effort",
      reasoningOff: false,
      reasoningLevels: "low, medium, xhigh",
      tools: false,
    });
    expect(out).toEqual({
      "other-model": { vision: true },
      "bonsai-2-27b-pq2": {
        vision: true,
        reasoningStrategy: "openai-effort",
        reasoningLevels: ["low", "medium", "xhigh"],
      },
    });
  });

  it("removes the override when the form is empty", () => {
    expect(buildModelCapabilities(all, "bonsai-2-27b-pq2", {})).toEqual({
      "other-model": { vision: true },
    });
  });

  it("does not mutate stored overrides", () => {
    buildModelCapabilities(all, "bonsai-2-27b-pq2", { vision: true });
    expect(all["bonsai-2-27b-pq2"]).toEqual({ tools: false });
  });
});
