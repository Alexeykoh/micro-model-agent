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
});
