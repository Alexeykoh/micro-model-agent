import { describe, it, expect } from "vitest";
import { OutputBus } from "../../src/output";
import { JsonOutputSink } from "../../src/output/json-sink";

describe("JsonOutputSink", () => {
  it("collects warn/error and ignores info/debug", () => {
    const bus = new OutputBus();
    const sink = new JsonOutputSink(bus);

    bus.log("info", "mma", "starting");
    bus.log("debug", "module:indexer", "scan");
    bus.log("warn", "module:probe.context", "context smaller than configured");
    bus.log("error", "tool:bash", "command failed");

    expect(sink.diagnostics()).toEqual([
      { level: "warn", source: "module:probe.context", text: "context smaller than configured" },
      { level: "error", source: "tool:bash", text: "command failed" },
    ]);

    sink.dispose();
  });

  it("dispose() detaches from the bus", () => {
    const bus = new OutputBus();
    const sink = new JsonOutputSink(bus);

    bus.log("warn", "mma", "before");
    sink.dispose();
    bus.log("error", "core", "after");

    expect(sink.diagnostics()).toEqual([{ level: "warn", source: "mma", text: "before" }]);
  });
});
