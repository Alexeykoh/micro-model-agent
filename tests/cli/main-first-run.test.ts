import { describe, it, expect } from "vitest";
import { order } from "../../src/cli/setup-order";

describe("order (first-run setup ordering)", () => {
  it("calls runSetup before bootstrap when hasConfig=false && interactive=true", async () => {
    const calls: string[] = [];
    const result = await order({
      hasConfig: false,
      interactive: true,
      runSetup: async () => {
        calls.push("setup");
        return { provider: "openai-compat" };
      },
      bootstrap: async () => {
        calls.push("bootstrap");
        return { ready: true };
      },
    });

    expect(calls).toEqual(["setup", "bootstrap"]);
    expect(result.answers).toEqual({ provider: "openai-compat" });
    expect(result.boot).toEqual({ ready: true });
  });

  it("skips runSetup and only bootstraps when hasConfig=true", async () => {
    const calls: string[] = [];
    const result = await order({
      hasConfig: true,
      interactive: true,
      runSetup: async () => {
        calls.push("setup");
        return null;
      },
      bootstrap: async () => {
        calls.push("bootstrap");
        return { ready: true };
      },
    });

    expect(calls).toEqual(["bootstrap"]);
    expect(result.answers).toBeNull();
  });

  it("skips runSetup when interactive=false", async () => {
    const calls: string[] = [];
    const result = await order({
      hasConfig: false,
      interactive: false,
      runSetup: async () => {
        calls.push("setup");
        return null;
      },
      bootstrap: async () => {
        calls.push("bootstrap");
        return { ready: true };
      },
    });

    expect(calls).toEqual(["bootstrap"]);
    expect(result.answers).toBeNull();
  });

  it("invokes applyAnswers (if provided) before bootstrap", async () => {
    const calls: string[] = [];
    const applied: unknown[] = [];
    await order({
      hasConfig: false,
      interactive: true,
      runSetup: async () => {
        calls.push("setup");
        return { provider: "lmstudio" };
      },
      applyAnswers: (a) => {
        calls.push("apply");
        applied.push(a);
      },
      bootstrap: async () => {
        calls.push("bootstrap");
        return {};
      },
    });

    expect(calls).toEqual(["setup", "apply", "bootstrap"]);
    expect(applied).toEqual([{ provider: "lmstudio" }]);
  });

  it("still bootstraps when runSetup returns null", async () => {
    const calls: string[] = [];
    const result = await order({
      hasConfig: false,
      interactive: true,
      runSetup: async () => {
        calls.push("setup");
        return null;
      },
      bootstrap: async () => {
        calls.push("bootstrap");
        return { ready: true };
      },
    });

    expect(calls).toEqual(["setup", "bootstrap"]);
    expect(result.answers).toBeNull();
    expect(result.boot).toEqual({ ready: true });
  });
});
