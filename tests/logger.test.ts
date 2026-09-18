import { describe, it, expect } from "vitest";
import { Logger } from "../src/logger/app-logger";
import { OutputBus, type OutputEvent } from "../src/output";

function collect(bus: OutputBus): OutputEvent[] {
  const events: OutputEvent[] = [];
  bus.subscribe((ev) => events.push(ev));
  return events;
}

describe("Logger", () => {
  it("should emit messages at correct level", () => {
    const bus = new OutputBus();
    const events = collect(bus);
    const logger = new Logger("debug", "", bus);

    logger.debug("debug msg");
    expect(events[0]).toMatchObject({ level: "debug", text: "debug msg" });

    logger.info("info msg");
    expect(events[1]).toMatchObject({ level: "info", text: "info msg" });

    logger.warn("warn msg");
    expect(events[2]).toMatchObject({ level: "warn", text: "warn msg" });

    logger.error("error msg");
    expect(events[3]).toMatchObject({ level: "error", text: "error msg" });
  });

  it("should filter by log level", () => {
    const bus = new OutputBus();
    const events = collect(bus);
    const logger = new Logger("warn", "", bus);

    logger.debug("debug msg");
    logger.info("info msg");
    expect(events).toHaveLength(0);

    logger.warn("warn msg");
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe("warn");
  });

  it("should format message with metadata", () => {
    const bus = new OutputBus();
    const events = collect(bus);
    const logger = new Logger("info", "", bus);

    logger.info("test", { key: "value" });
    expect(events[0].text).toContain("test");
    expect(events[0].text).toContain("key");
    expect(events[0].text).toContain("value");
  });

  it("should set level dynamically", () => {
    const bus = new OutputBus();
    const events = collect(bus);
    const logger = new Logger("error", "", bus);

    logger.setLevel("info");
    logger.info("now visible");
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe("now visible");
  });

  it("should create child logger with prefix", () => {
    const bus = new OutputBus();
    const events = collect(bus);
    const logger = new Logger("info", "", bus);
    const child = logger.child("tools");

    child.info("hello");
    expect(events[0].source).toBe("tools");
    expect(events[0].text).toBe("hello");
  });

  it("should compose nested child prefixes", () => {
    const bus = new OutputBus();
    const events = collect(bus);
    const child = new Logger("info", "root", bus).child("tools");

    child.info("hello");
    expect(events[0].source).toBe("root:tools");
  });

  it("defaults source to mma when no prefix is set", () => {
    const bus = new OutputBus();
    const events = collect(bus);
    new Logger("info", "", bus).info("hi");
    expect(events[0].source).toBe("mma");
  });

  it("does not emit logStructured/logSilent to the bus", () => {
    const bus = new OutputBus();
    const events = collect(bus);
    const logger = new Logger("debug", "", bus);

    logger.logStructured("env", { a: 1 });
    logger.logSilent("warn", "quiet");
    expect(events).toHaveLength(0);
  });
});
