import { describe, it, expect } from "vitest";
import { WebHost } from "../src/core/web-host";

describe("WebHost", () => {
  it("delegates submit to runAgent and guards busy", async () => {
    let busy = false;
    const ran: string[] = [];
    const host = new WebHost({
      runAgent: async (t) => {
        ran.push(t);
        return "ok";
      },
      isBusy: () => busy,
      interrupt: () => {
        busy = false;
      },
      executeCommand: async () => {},
      getState: () => ({ busy }),
    });
    expect(await host.submit("hi")).toBe("ok");
    expect(ran).toEqual(["hi"]);
    busy = true;
    await expect(host.submit("again")).rejects.toThrow("agent is busy");
  });

  it("executeCommand ignores non-slash input", async () => {
    let called = 0;
    const host = new WebHost({
      runAgent: async () => "x",
      isBusy: () => false,
      interrupt: () => {},
      executeCommand: async () => {
        called++;
      },
      getState: () => ({ busy: false }),
    });
    await host.executeCommand("hello");
    expect(called).toBe(0);
    await host.executeCommand("/status");
    expect(called).toBe(1);
  });
});
