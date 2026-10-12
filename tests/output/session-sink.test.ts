import { describe, it, expect } from "vitest";
import { OutputBus } from "../../src/output";
import { SessionOutputSink } from "../../src/output/session-sink";
import type { SessionLogEntry } from "../../src/modules/session/store";

describe("SessionOutputSink", () => {
  it("persists only events marked data.persist === true", () => {
    const bus = new OutputBus();
    const logs: SessionLogEntry[] = [];
    const sink = new SessionOutputSink(bus, { appendLog: (entry) => logs.push(entry) });

    bus.log("info", "module:indexer", "transient");
    bus.log("warn", "module:probe.context", "kept", { persist: true });
    bus.log("error", "tool:bash", "drop", { persist: false });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      type: "output",
      level: "warn",
      source: "module:probe.context",
      content: "kept",
    });
    expect(typeof logs[0].ts).toBe("string");

    sink.dispose();
  });

  it("dispose() detaches from the bus", () => {
    const bus = new OutputBus();
    const logs: SessionLogEntry[] = [];
    const sink = new SessionOutputSink(bus, { appendLog: (entry) => logs.push(entry) });

    bus.log("warn", "mma", "before", { persist: true });
    sink.dispose();
    bus.log("warn", "core", "after", { persist: true });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ source: "mma", content: "before" });
  });
});
