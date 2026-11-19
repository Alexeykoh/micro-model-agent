import { describe, it, expect } from "vitest";
import { WebHost } from "../src/core/web-host";
import type { HostBridgeSubmitOptions } from "../src/modules/types";

describe("WebHost (W10)", () => {
  it("delegates submit to the single turn entry point and passes the options", async () => {
    const calls: Array<{ text: string; opts?: HostBridgeSubmitOptions }> = [];
    const host = new WebHost({
      submitTurn: async (text, opts) => {
        calls.push({ text, opts });
        return { ok: true, sessionId: "S1" };
      },
      isBusy: () => false,
      interrupt: () => {},
      executeCommand: async () => ({ ok: true, output: [] }),
      getState: () => ({ busy: false }),
    });

    const out = await host.submit("hi", {
      sessionId: "S1",
      images: ["data:image/png;base64,AA=="],
    });
    expect(out).toMatchObject({ ok: true, sessionId: "S1" });
    expect(calls).toEqual([
      {
        text: "hi",
        opts: { sessionId: "S1", images: ["data:image/png;base64,AA=="] },
      },
    ]);
  });

  it("executeCommand ignores non-slash input", async () => {
    let called = 0;
    const host = new WebHost({
      submitTurn: async () => "x",
      isBusy: () => false,
      interrupt: () => {},
      executeCommand: async () => {
        called++;
        return { ok: true, output: [] };
      },
      getState: () => ({ busy: false }),
    });
    await host.executeCommand("hello");
    expect(called).toBe(0);
    await host.executeCommand("/status");
    expect(called).toBe(1);
  });
});
