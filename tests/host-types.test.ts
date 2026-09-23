import { describe, it, expect } from "vitest";
import { createHostBridge } from "../src/core/host";

describe("core/host", () => {
  it("createHostBridge rejects submit while busy", async () => {
    const bridge = createHostBridge({
      isBusy: () => true,
      addPendingImage: () => {},
      runAgent: async () => "ran",
      interruptRun: () => {},
    });
    await expect(bridge.submit("hi")).rejects.toThrow("agent is busy");
  });

  it("createHostBridge forwards images then runs", async () => {
    const images: string[] = [];
    let ran = "";
    const bridge = createHostBridge({
      isBusy: () => false,
      addPendingImage: (u) => images.push(u),
      runAgent: async (t) => {
        ran = t;
        return "ok";
      },
      interruptRun: () => {},
    });
    const out = await bridge.submit("hello", { images: ["data:image/png;base64,AAA"] });
    expect(out).toBe("ok");
    expect(ran).toBe("hello");
    expect(images).toEqual(["data:image/png;base64,AAA"]);
  });

  it("createHostBridge interrupt is a no-op when idle", () => {
    let interrupted = false;
    const bridge = createHostBridge({
      isBusy: () => false,
      addPendingImage: () => {},
      runAgent: async () => "x",
      interruptRun: () => {
        interrupted = true;
      },
    });
    bridge.interrupt();
    expect(interrupted).toBe(false);
  });
});
