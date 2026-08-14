import { describe, expect, it } from "bun:test";
import { BridgeDriver } from "../src/modules/browser/bridge-client";

describe("BridgeDriver", () => {
  it("pings the node bridge over stdio", async () => {
    const bridge = new BridgeDriver({ maxConsoleLineChars: 100 });
    await bridge.launch({
      headless: true,
      viewport: { width: 640, height: 480 },
      timeoutMs: 15000,
    });

    const title = await bridge.title();
    expect(title).toBe("");

    const cookies = await bridge.cookies();
    expect(Array.isArray(cookies)).toBe(true);

    await bridge.close();
  });

  it("fails cleanly on timeout-less shutdown", async () => {
    const bridge = new BridgeDriver();
    // close() without launch must not throw
    await bridge.close();
  });
});