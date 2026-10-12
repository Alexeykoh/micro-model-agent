import { describe, it, expect, afterEach, vi } from "vitest";
import { Repl } from "../../src/cli/repl";
import type { Agent } from "../../src/core/agent";
import type { AppConfig } from "../../src/config/types";
import type { HostStateSnapshot } from "../../src/core/host";
import { defaultOutputBus, type OutputEvent } from "../../src/output";
import { makeCaptureChannel } from "./capture-channel";

/**
 * Minimal harness: no real Agent/PluginManager. `Repl` degrades gracefully
 * when `execModule`/`sessionManager` are absent, which is exactly the surface
 * the `Host` methods must tolerate.
 */
function makeRepl(): { repl: Repl; shutdown: ReturnType<typeof vi.fn> } {
  const { channel } = makeCaptureChannel();
  const shutdown = vi.fn();
  const agent = {
    shutdown,
    run: async () => ({}),
    tryToolContext: () => undefined,
  } as unknown as Agent;
  const config = { ui: {} } as unknown as AppConfig;
  const repl = new Repl(
    agent,
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    channel,
  );
  return { repl, shutdown };
}

describe("Repl Host surface", () => {
  afterEach(() => {
    defaultOutputBus.reset();
  });

  it("is idle initially", () => {
    const { repl } = makeRepl();
    expect(repl.isBusy()).toBe(false);
  });

  it("interrupt is inert while idle (no throw, no callback)", () => {
    const { repl, shutdown } = makeRepl();
    expect(() => repl.interrupt()).not.toThrow();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("subscribeOutput returns a working unsubscribe", () => {
    const { repl } = makeRepl();
    const seen: OutputEvent[] = [];
    const unsub = repl.subscribeOutput((ev) => seen.push(ev));

    defaultOutputBus.log("warn", "module:probe.context", "before unsubscribe");
    expect(seen).toHaveLength(1);

    unsub();
    defaultOutputBus.log("error", "module:mcp", "after unsubscribe");
    expect(seen).toHaveLength(1);
  });

  it("getState returns a HostStateSnapshot-shaped object without modules", () => {
    const { repl } = makeRepl();
    const state = repl.getState() as HostStateSnapshot;
    expect(typeof state.busy).toBe("boolean");
    expect(state.busy).toBe(false);
    expect(state.sessionId).toBeUndefined();
    expect(state.plan).toBeNull();
  });
});
