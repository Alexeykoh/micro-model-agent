import { afterEach, describe, it, expect } from "vitest";
import { OutputBus, defaultOutputBus } from "../../src/output/bus";

describe("OutputBus", () => {
  afterEach(() => defaultOutputBus.reset());

  it("assigns monotonic ids and timestamps", () => {
    const bus = new OutputBus();
    const a = bus.emit({ level: "info", source: "mma", kind: "log", text: "a" });
    const b = bus.emit({ level: "info", source: "mma", kind: "log", text: "b" });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(b.ts).toBeGreaterThanOrEqual(a.ts);
  });
  it("delivers to every subscriber and stops after unsubscribe", () => {
    const bus = new OutputBus();
    const seen: string[] = [];
    const off = bus.subscribe((e) => seen.push(`a:${e.text}`));
    bus.subscribe((e) => seen.push(`b:${e.text}`));
    bus.log("warn", "indexer", "hello");
    off();
    bus.log("info", "s", "bye");
    expect(seen).toEqual(["a:hello", "b:hello", "b:bye"]);
  });
  it("isolates a throwing subscriber", () => {
    const bus = new OutputBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((e) => seen.push(e.text));
    expect(() => bus.log("info", "s", "x")).not.toThrow();
    expect(seen).toEqual(["x"]);
  });
  it("resets subscribers and id sequence on the default bus", () => {
    const seen: string[] = [];
    defaultOutputBus.subscribe((e) => seen.push(e.text));
    defaultOutputBus.reset();
    const ev = defaultOutputBus.emit({
      level: "info",
      source: "mma",
      kind: "log",
      text: "after-reset",
    });
    expect(seen).toEqual([]);
    expect(ev.id).toBe(1);
  });
});
