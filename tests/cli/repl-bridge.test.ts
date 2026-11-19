import { describe, it, expect, afterEach, vi } from "vitest";
import { createHostBridge } from "../../src/cli/repl";
import { defaultOutputBus, type OutputEvent } from "../../src/output";

describe("createHostBridge", () => {
  afterEach(() => {
    defaultOutputBus.reset();
  });

  function makeOpts(overrides?: Partial<Parameters<typeof createHostBridge>[0]>) {
    return {
      isBusy: vi.fn().mockReturnValue(false),
      addPendingImage: vi.fn(),
      runAgent: vi.fn().mockResolvedValue({ success: true }),
      interruptRun: vi.fn(),
      ...overrides,
    };
  }

  it("submits text when idle", async () => {
    const opts = makeOpts();
    const bridge = createHostBridge(opts);
    expect(bridge.isBusy()).toBe(false);
    await expect(bridge.submit("hello")).resolves.toBeDefined();
    expect(opts.runAgent).toHaveBeenCalledWith("hello");
    expect(opts.addPendingImage).not.toHaveBeenCalled();
  });

  it("rejects when busy without calling runAgent", async () => {
    const opts = makeOpts({ isBusy: vi.fn().mockReturnValue(true) });
    const bridge = createHostBridge(opts);
    await expect(bridge.submit("nope")).rejects.toThrow(/busy/i);
    expect(opts.runAgent).not.toHaveBeenCalled();
  });

  it("attaches images before running the agent", async () => {
    const opts = makeOpts();
    const bridge = createHostBridge(opts);
    const url = "data:image/jpeg;base64,AAA";
    await bridge.submit("look", { images: [url] });
    expect(opts.addPendingImage).toHaveBeenCalledWith(url);
    expect(opts.addPendingImage).toHaveBeenCalledTimes(1);
    expect(opts.runAgent).toHaveBeenCalledWith("look");
  });

  it("subscribeOutput forwards defaultOutputBus events until unsubscribed", () => {
    const bridge = createHostBridge(makeOpts());
    const seen: OutputEvent[] = [];
    const unsub = bridge.subscribeOutput!((ev) => seen.push(ev));

    defaultOutputBus.log("warn", "module:probe.context", "small context");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "log",
      level: "warn",
      source: "module:probe.context",
      text: "small context",
    });

    unsub();
    defaultOutputBus.log("error", "module:mcp", "after unsubscribe");
    expect(seen).toHaveLength(1);
  });

  it("interrupt only fires while busy", () => {
    let busy = true;
    const opts = makeOpts({
      isBusy: () => busy,
      interruptRun: vi.fn(() => {
        busy = false;
      }),
    });
    const bridge = createHostBridge(opts);
    bridge.interrupt();
    expect(opts.interruptRun).toHaveBeenCalledTimes(1);
    bridge.interrupt();
    expect(opts.interruptRun).toHaveBeenCalledTimes(1);
  });
});
