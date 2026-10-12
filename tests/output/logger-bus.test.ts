import { describe, it, expect } from "vitest";
import { Logger } from "../../src/logger/app-logger";
import { OutputBus, type OutputEvent } from "../../src/output";

function collect(bus: OutputBus): OutputEvent[] {
  const events: OutputEvent[] = [];
  bus.subscribe((ev) => events.push(ev));
  return events;
}

describe("Logger → OutputBus", () => {
  it("emits a log event with source, level and text", () => {
    const bus = new OutputBus();
    const events = collect(bus);
    const logger = new Logger("info", "indexer", bus);

    logger.warn("boom");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "module:indexer",
      level: "warn",
      kind: "log",
      text: "boom",
    });
  });

  it("filters events below the configured level", () => {
    const bus = new OutputBus();
    const events = collect(bus);
    const logger = new Logger("warn", "", bus);

    logger.info("ignored");
    expect(events).toHaveLength(0);

    logger.error("kept");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "error", text: "kept" });
  });
});
