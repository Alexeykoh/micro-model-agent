// Повторная capability-проба холодной локальной модели (llama-swap):
// первая проба не прочитала /props, поэтому уровни рассуждений отсутствуют;
// когда модель загрузилась, нужно переспросить бэкенд и обновить живой снимок.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig, ModelCapabilities } from "../../src/config/types";
import { readCachedCapabilities } from "../../src/modules/providers/capabilities-cache";
import {
  markReasoningReprobe,
  retryReasoningDiscovery,
  type DiscoveredLike,
  type CapsDeps,
} from "../../src/core/agent/reasoning-reprobe";
import type { DiscoveredCapabilities } from "../../src/core/agent/provider-probes";

const originalDir = process.env.MMA_CONFIG_DIR;
const dirs: string[] = [];

function isolatedDir(): void {
  const dir = mkdtempSync(join(tmpdir(), "mma-reprobe-"));
  dirs.push(dir);
  process.env.MMA_CONFIG_DIR = dir;
}

afterEach(() => {
  if (originalDir === undefined) delete process.env.MMA_CONFIG_DIR;
  else process.env.MMA_CONFIG_DIR = originalDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testConfig(): AppConfig {
  const config = structuredClone(DEFAULTS);
  config.provider.type = "openai-compat";
  config.provider.baseUrl = "http://host.docker.internal:8080/v1";
  config.model = "deepseek-v4-pro-9b";
  return config;
}

function testHost(): { deps: CapsDeps } {
  return {
    deps: {
      config: testConfig(),
      capabilitiesProbeRef: {
        probe: { vision: true, video: true },
        reachable: true,
        needsReasoningReprobe: true,
      },
      reasoningStrategy: "prompt-tag",
      reasoningLevels: undefined,
    },
  };
}

function discovered(caps?: ModelCapabilities): DiscoveredCapabilities {
  return {
    capabilities: caps ?? { vision: true, video: true },
    reachable: true,
  };
}

describe("markReasoningReprobe", () => {
  it("sets the flag for a reachable local backend that declared no reasoning", () => {
    isolatedDir();
    const host = testHost();
    host.deps.capabilitiesProbeRef!.needsReasoningReprobe = false;
    markReasoningReprobe(host.deps.capabilitiesProbeRef!, discovered(), "openai-compat");
    expect(host.deps.capabilitiesProbeRef!.needsReasoningReprobe).toBe(true);
  });

  it("clears the flag once native reasoning was declared", () => {
    const host = testHost();
    markReasoningReprobe(host.deps.capabilitiesProbeRef!, discovered({ reasoningStrategy: "template-kwarg", reasoningOff: true }), "openai-compat");
    expect(host.deps.capabilitiesProbeRef!.needsReasoningReprobe).toBe(false);
  });

  it("does not schedule pointless retries for a hosted provider type", () => {
    const host = testHost();
    host.deps.capabilitiesProbeRef!.needsReasoningReprobe = false;
    markReasoningReprobe(host.deps.capabilitiesProbeRef!, discovered(), "openrouter");
    expect(host.deps.capabilitiesProbeRef!.needsReasoningReprobe).toBe(false);
  });
});

describe("retryReasoningDiscovery", () => {
  it("keeps waiting while the model is still cold", async () => {
    isolatedDir();
    const host = testHost();
    let calls = 0;
    const probe: DiscoveredLike = async () => {
      calls++;
      return discovered();
    };
    expect(await retryReasoningDiscovery(host.deps, host.deps.config, probe)).toBe(false);
    expect(calls).toBe(1);
    expect(host.deps.capabilitiesProbeRef!.needsReasoningReprobe).toBe(true);
    expect(host.deps.capabilitiesProbeRef!.reasoningStrategy).toBeUndefined();
  });

  it("publishes native reasoning and caches it once the model answered", async () => {
    isolatedDir();
    const host = testHost();
    const native: ModelCapabilities = {
      vision: true,
      video: true,
      reasoningStrategy: "template-kwarg",
      reasoningOff: true,
    };
    const probe: DiscoveredLike = async () => discovered(native);
    expect(await retryReasoningDiscovery(host.deps, host.deps.config, probe)).toBe(true);
    const ref = host.deps.capabilitiesProbeRef!;
    expect(ref.needsReasoningReprobe).toBe(false);
    expect(ref.probe).toMatchObject(native);
    expect(ref.reasoningStrategy).toBe("template-kwarg");
    expect(ref.reasoningOff).toBe(true);
    expect(host.deps.reasoningStrategy).toBe("template-kwarg");
    expect(readCachedCapabilities(host.deps.config.provider.baseUrl, host.deps.config.model)).toMatchObject(native);
  });

  it("does not hammer the backend on every /api/models read", async () => {
    isolatedDir();
    const host = testHost();
    let calls = 0;
    const probe: DiscoveredLike = async () => {
      calls++;
      return discovered();
    };
    await retryReasoningDiscovery(host.deps, host.deps.config, probe);
    await retryReasoningDiscovery(host.deps, host.deps.config, probe);
    expect(calls).toBe(1);
  });
});
