import { describe, it, expect, vi } from "vitest";
import { applyProbedContext } from "../../src/core/bootstrap";
import { DEFAULTS } from "../../src/config/defaults";

function stubLogger() {
  return { logSilent: vi.fn() };
}

describe("applyProbedContext", () => {
  it("reconfigures when the probe value is current and no turn ran", async () => {
    const config = structuredClone(DEFAULTS);
    config.contextWindow = 1000000;
    const agent = { currentIteration: 0, reconfigure: vi.fn(async () => {}) };
    const logger = stubLogger();
    const ok = await applyProbedContext(
      agent,
      config,
      { model: "deepseek-v4.1-flash", actual: 1000000 },
      logger,
    );
    expect(ok).toBe(true);
    expect(agent.reconfigure).toHaveBeenCalledTimes(1);
    expect(logger.logSilent).toHaveBeenCalledWith("info", expect.stringContaining("applied"));
  });

  it("skips when the config no longer carries the probed value", async () => {
    const config = structuredClone(DEFAULTS);
    config.contextWindow = 32768;
    const agent = { currentIteration: 0, reconfigure: vi.fn(async () => {}) };
    const ok = await applyProbedContext(
      agent,
      config,
      { model: "m", actual: 1000000 },
      stubLogger(),
    );
    expect(ok).toBe(false);
    expect(agent.reconfigure).not.toHaveBeenCalled();
    expect(config.contextWindow).toBe(32768);
  });

  it("skips when a turn already ran with the old window", async () => {
    const config = structuredClone(DEFAULTS);
    config.contextWindow = 1000000;
    const agent = { currentIteration: 3, reconfigure: vi.fn(async () => {}) };
    const logger = stubLogger();
    const ok = await applyProbedContext(
      agent,
      config,
      { model: "m", actual: 1000000 },
      logger,
    );
    expect(ok).toBe(false);
    expect(agent.reconfigure).not.toHaveBeenCalled();
    expect(logger.logSilent).toHaveBeenCalledWith("debug", expect.stringContaining("keeping"));
  });

  it("swallows reconfigure errors (fail-open)", async () => {
    const config = structuredClone(DEFAULTS);
    config.contextWindow = 1000000;
    const agent = {
      currentIteration: 0,
      reconfigure: vi.fn(async () => {
        throw new Error("down");
      }),
    };
    const ok = await applyProbedContext(
      agent,
      config,
      { model: "m", actual: 1000000 },
      stubLogger(),
    );
    expect(ok).toBe(false);
  });

  it("syncs the effective window into the session meta", async () => {
    // ses_muz7sg1l_0ankgu: проба авто-подставила 262144 в конфиг, а meta.json
    // и session_start продолжали показывать 65536 (окно из SessionManager.create()
    // до пробы) — расхождение не диагностировалось.
    const config = structuredClone(DEFAULTS);
    config.contextWindow = 262144;
    config.model = "qwen3.8-9b-distill";
    const agent = { currentIteration: 0, reconfigure: vi.fn(async () => {}) };
    const setEffectiveContext = vi.fn();

    const ok = await applyProbedContext(
      agent,
      config,
      { model: "qwen3.8-9b-distill", actual: 262144 },
      stubLogger(),
      { setEffectiveContext },
    );

    expect(ok).toBe(true);
    expect(setEffectiveContext).toHaveBeenCalledWith(262144, "qwen3.8-9b-distill");
  });

  it("does not touch the session meta when the probe is not applied", async () => {
    const config = structuredClone(DEFAULTS);
    config.contextWindow = 32768;
    const agent = { currentIteration: 0, reconfigure: vi.fn(async () => {}) };
    const setEffectiveContext = vi.fn();

    await applyProbedContext(
      agent,
      config,
      { model: "m", actual: 1000000 },
      stubLogger(),
      { setEffectiveContext },
    );

    expect(setEffectiveContext).not.toHaveBeenCalled();
  });
});
