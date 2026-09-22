import { describe, it, expect } from "vitest";
import { applyAnswersToConfig } from "../../src/cli/setup-order";
import type { SetupAnswers } from "../../src/cli/setup";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import { applyReasoningCliOverride } from "../../src/core/bootstrap";

function makeAnswers(overrides: Partial<SetupAnswers> = {}): SetupAnswers {
  return {
    provider: "openai-compat",
    apiBase: "http://localhost:1234/v1",
    apiKey: "secret-key",
    model: "qwen/qwen3.5-9b",
    contextWindow: 32768,
    maxToolIterations: 1000,
    locale: "en",
    securityBashBlock: false,
    securityFlagsBlock: false,
    securityPathsRestrict: true,
    ...overrides,
  };
}

function makeConfig(): AppConfig {
  return structuredClone(DEFAULTS);
}

describe("applyAnswersToConfig", () => {
  it("replaces the provider object identity instead of mutating it", () => {
    const config = makeConfig();
    const before = config.provider;
    applyAnswersToConfig(config, makeAnswers());

    expect(Object.is(config.provider, before)).toBe(false);
    expect(config.provider.type).toBe("openai-compat");
    expect(config.provider.baseUrl).toBe("http://localhost:1234/v1");
    expect(config.provider.apiKey).toBe("secret-key");
  });

  it("sets model, contextWindow, maxToolIterations and locale", () => {
    const config = makeConfig();
    applyAnswersToConfig(
      config,
      makeAnswers({
        model: "my-model",
        contextWindow: 65536,
        maxToolIterations: 42,
        locale: "ru",
      }),
    );

    expect(config.model).toBe("my-model");
    expect(config.contextWindow).toBe(65536);
    expect(config.maxToolIterations).toBe(42);
    expect(config.locale).toBe("ru");
  });

  it("enables security with defaults preserved", () => {
    const config = makeConfig();
    config.security.enabled = false;
    config.security.bash.enabled = false;
    applyAnswersToConfig(config, makeAnswers());

    expect(config.security.enabled).toBe(true);
    expect(config.security.bash.enabled).toBe(true);
  });

  it("enables path policy with defaults when securityPathsRestrict=true", () => {
    const config = makeConfig();
    applyAnswersToConfig(config, makeAnswers({ securityPathsRestrict: true }));

    expect(config.security.paths.enabled).toBe(true);
    expect(config.security.paths.denied.length).toBeGreaterThan(0);
  });

  it("disables path policy and clears denied paths when securityPathsRestrict=false", () => {
    const config = makeConfig();
    expect(config.security.paths.denied.length).toBeGreaterThan(0);
    applyAnswersToConfig(config, makeAnswers({ securityPathsRestrict: false }));

    expect(config.security.paths.enabled).toBe(false);
    expect(config.security.paths.denied).toEqual([]);
  });

  it("extends the bash blacklist when securityBashBlock=true", () => {
    const config = makeConfig();
    config.security.bash.blacklist = [];
    applyAnswersToConfig(config, makeAnswers({ securityBashBlock: true }));

    expect(config.security.bash.blacklist).toContain("rm");
    expect(config.security.bash.blacklist).toContain("sudo");
    expect(config.security.bash.blacklist).toContain("curl");
    expect(config.security.bash.blacklist.length).toBe(16);
  });

  it("does not duplicate existing blacklist entries", () => {
    const config = makeConfig();
    config.security.bash.blacklist = ["rm", "sudo"];
    applyAnswersToConfig(config, makeAnswers({ securityBashBlock: true }));

    expect(config.security.bash.blacklist.filter((c) => c === "rm")).toHaveLength(1);
  });
});

describe("applyReasoningCliOverride", () => {
  it("sets reasoning.mode for a non-auto level", () => {
    const config = makeConfig();
    applyReasoningCliOverride(config, "high");
    expect(config.reasoning.mode).toBe("high");
  });

  it("leaves reasoning untouched for undefined and auto", () => {
    const config = makeConfig();
    config.reasoning.mode = "low";
    applyReasoningCliOverride(config, undefined);
    expect(config.reasoning.mode).toBe("low");
    applyReasoningCliOverride(config, "auto");
    expect(config.reasoning.mode).toBe("low");
  });
});
