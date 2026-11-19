import { describe, it, expect } from "vitest";
import { LocalHost, type LocalHostDeps } from "../../src/core/local-host";
import type { HostEvent, HostStateSnapshot } from "../../src/core/host";
import type { OutputEvent } from "../../src/output/types";

function makeHost(overrides: Partial<LocalHostDeps> = {}) {
  const calls = { submitted: [] as string[], interrupted: 0, commands: [] as string[] };
  const listeners: Array<(ev: OutputEvent) => void> = [];
  const snapshot: HostStateSnapshot = { busy: false, sessionId: "S" };
  const host = new LocalHost({
    isBusy: () => false,
    submit: async (text) => {
      calls.submitted.push(text);
      return "ok";
    },
    interrupt: () => {
      calls.interrupted++;
    },
    subscribeOutput: (fn) => {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    executeCommand: async (line) => {
      calls.commands.push(line);
    },
    getState: () => snapshot,
    ...overrides,
  });
  return { host, calls, listeners, snapshot };
}

function outputEvent(over: Partial<OutputEvent> = {}): OutputEvent {
  return {
    id: 7,
    ts: 1000,
    level: "warn",
    source: "module:mcp",
    kind: "log",
    text: "degraded",
    sessionId: "S",
    ...over,
  };
}

describe("LocalHost (split W1)", () => {
  it("getState is async and returns the injected snapshot", async () => {
    const { host, snapshot } = makeHost();
    const state = host.getState("S");
    expect(state).toBeInstanceOf(Promise);
    await expect(state).resolves.toBe(snapshot);
  });

  it("submit/interrupt/executeCommand delegate to the owner run path", async () => {
    const { host, calls } = makeHost();
    await expect(host.submit("hello")).resolves.toBe("ok");
    host.interrupt();
    await host.executeCommand("/status");
    expect(calls.submitted).toEqual(["hello"]);
    expect(calls.interrupted).toBe(1);
    expect(calls.commands).toEqual(["/status"]);
  });

  it("subscribeEvents wraps OutputEvent into a wire-safe HostEvent", () => {
    const { host, listeners } = makeHost();
    const seen: HostEvent[] = [];
    const unsub = host.subscribeEvents((ev) => seen.push(ev));

    listeners[0](outputEvent());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: "output",
      ts: 1000,
      sessionId: "S",
      source: "module:mcp",
    });
    expect((seen[0].data as OutputEvent).text).toBe("degraded");

    unsub();
    expect(listeners).toHaveLength(0);
  });

  it("isBusy reflects the owner predicate", () => {
    const { host } = makeHost({ isBusy: () => true });
    expect(host.isBusy()).toBe(true);
  });
});
