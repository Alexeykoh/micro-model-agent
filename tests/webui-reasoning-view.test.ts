import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config/defaults";
import type { AppConfig } from "../src/config/types";
import { buildReasoningView } from "../src/modules/webui/settings/reasoning-view";
import {
  setCachedProbeResult,
  resetProbeCache,
  cacheKey,
  rememberReasoningMechanism,
} from "../src/modules/reasoning/probe";
import { createWebUiState } from "../src/modules/webui/state";
import { withServer, doFetch } from "./helpers/webui-server";

process.env.MMA_REASONING_CACHE = join(tmpdir(), `mma-reasoning-test-${process.pid}.json`);

function testConfig(): AppConfig {
  return structuredClone(DEFAULTS);
}

beforeEach(() => {
  resetProbeCache();
});

describe("buildReasoningView", () => {
  it("resolves openai-effort for the openai preset", () => {
    const config = testConfig();
    config.provider.type = "openai";
    config.provider.baseUrl = "https://api.openai.com/v1";
    config.model = "gpt-5-mini";
    const view = buildReasoningView(config);
    expect(view.strategy).toBe("openai-effort");
    expect(view.supported).toBeNull();
    expect(view.mode).toBe("auto");
  });

  it("resolves prompt-tag for lmstudio and none for anthropic", () => {
    const lm = testConfig();
    lm.provider.type = "lmstudio";
    lm.provider.baseUrl = "http://localhost:1234/v1";
    expect(buildReasoningView(lm).strategy).toBe("prompt-tag");

    const anthropic = testConfig();
    anthropic.provider.type = "anthropic";
    expect(buildReasoningView(anthropic).strategy).toBe("none");
  });

  it("falls back to none for an unknown provider type", () => {
    const config = testConfig();
    config.provider.type = "custom-thing";
    expect(buildReasoningView(config).strategy).toBe("none");
  });

  it("prefers the active entry over stale flat fields", () => {
    const config = testConfig();
    config.provider.type = "openai";
    config.provider.baseUrl = "https://api.openai.com/v1";
    config.provider.active = "local";
    config.provider.entries = [
      { type: "openai-compat", label: "local", baseUrl: "http://localhost:11434/v1" },
    ];
    const view = buildReasoningView(config);
    expect(view.strategy).toBe("prompt-tag");
  });

  it("reads the cached probe verdict for the active baseUrl|model|mechanism", () => {
    const config = testConfig();
    config.provider.type = "openai";
    config.provider.baseUrl = "https://api.openai.com/v1";
    config.model = "gpt-5-mini";
    const key = cacheKey("https://api.openai.com/v1", "gpt-5-mini", "openai-effort", false);
    setCachedProbeResult(key, true);
    expect(buildReasoningView(config).supported).toBe(true);
    setCachedProbeResult(key, false);
    expect(buildReasoningView(config).supported).toBe(false);
  });

  it("uses the mechanism the agent actually resolved, not just the preset (INV-R8)", () => {
    const config = testConfig();
    config.provider.type = "lmstudio";
    config.provider.baseUrl = "http://localhost:1234/v1";
    config.model = "qwen/qwen3.5-9b";
    const presetOnly = buildReasoningView(config);
    expect(presetOnly.strategy).toBe("prompt-tag");

    rememberReasoningMechanism("http://localhost:1234/v1", "qwen/qwen3.5-9b", {
      strategy: "openai-effort",
      reasoningOff: true,
    });
    const withAgent = buildReasoningView(config);
    expect(withAgent.strategy).toBe("openai-effort");
    expect(withAgent.reasoningOff).toBe(true);
  });

  it("reports the configured reasoning mode", () => {
    const config = testConfig();
    config.reasoning = { ...config.reasoning!, mode: "high" };
    expect(buildReasoningView(config).mode).toBe("high");
  });
});

describe("GET /api/models reasoning shape", () => {
  it("includes reasoning when a config is wired", async () => {
    const s = createWebUiState();
    s.knownModels = () => ["gpt-5-mini"];
    const config = testConfig();
    config.provider.type = "openai";
    config.provider.baseUrl = "https://api.openai.com/v1";
    config.model = "gpt-5-mini";
    s.config = config;
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/models`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.models).toEqual(["gpt-5-mini"]);
      expect(body.reasoning).toEqual({
        strategy: "openai-effort",
        reasoningOff: false,
        supported: null,
        mode: "auto",
      });
    });
  });
});
