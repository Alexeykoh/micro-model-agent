import { describe, it, expect } from "vitest";
import { OutputBus } from "../../src/output/bus";

describe("OutputBus", () => {
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
    bus.subscribe(() => { throw new Error("boom"); });
    bus.subscribe((e) => seen.push(e.text));
    expect(() => bus.log("info", "s", "x")).not.toThrow();
    expect(seen).toEqual(["x"]);
  });
});
