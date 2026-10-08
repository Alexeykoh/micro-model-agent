import { describe, it, expect } from "vitest";
import {
  isLocalSingleEngine,
  resolveParallelSubtasks,
  LOCAL_PARALLEL_SUBTASKS,
} from "../../../src/modules/execution/moe-parallelism";
import { DEFAULTS } from "../../../src/config/defaults";
import type { AppConfig } from "../../../src/config/types";

function withProvider(patch: Partial<AppConfig["provider"]>): AppConfig {
  const config = structuredClone(DEFAULTS);
  config.provider = { ...config.provider, ...patch };
  return config;
}

describe("isLocalSingleEngine", () => {
  it("detects LM Studio and Ollama by type", () => {
    expect(isLocalSingleEngine(withProvider({ type: "lmstudio" }))).toBe(true);
    expect(isLocalSingleEngine(withProvider({ type: "ollama" }))).toBe(true);
  });

  it("detects a loopback openai-compat backend", () => {
    const config = withProvider({ type: "openai-compat", baseUrl: "http://127.0.0.1:8080/v1" });
    expect(isLocalSingleEngine(config)).toBe(true);
  });

  it("does not flag hosted providers", () => {
    expect(
      isLocalSingleEngine(withProvider({ type: "openai-compat", baseUrl: "https://api.openai.com/v1" })),
    ).toBe(false);
  });

  it("resolves the active provider entry, not the flat legacy fields", () => {
    const config = withProvider({
      type: "openai-compat",
      baseUrl: "http://localhost:1234/v1",
      active: "hosted",
      entries: [
        { type: "openai-compat", label: "hosted", baseUrl: "https://example.com/v1" },
      ],
    } as Partial<AppConfig["provider"]>);
    expect(isLocalSingleEngine(config)).toBe(false);
  });
});

describe("resolveParallelSubtasks", () => {
  it("runs subtasks serially on a local single-engine backend", () => {
    // ses_muz7sg1l_0ankgu: две подзадачи волны на LM Studio → "Engine protocol
    // startup was aborted".
    expect(resolveParallelSubtasks(withProvider({ type: "lmstudio" }))).toBe(
      LOCAL_PARALLEL_SUBTASKS,
    );
  });

  it("uses the rate-limit cap for hosted providers", () => {
    const config = withProvider({ type: "openai-compat", baseUrl: "https://api.openai.com/v1" });
    config.security!.rateLimits!.maxParallelTasks = 4;
    expect(resolveParallelSubtasks(config)).toBe(4);
  });

  it("honours an explicit moe.parallelSubtasks override", () => {
    const config = withProvider({ type: "lmstudio" });
    config.moe.parallelSubtasks = 3;
    expect(resolveParallelSubtasks(config)).toBe(3);
  });

  it("treats 0 / undefined as auto", () => {
    const config = withProvider({ type: "lmstudio" });
    config.moe.parallelSubtasks = 0;
    expect(resolveParallelSubtasks(config)).toBe(LOCAL_PARALLEL_SUBTASKS);
  });
});
