import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Logger } from "../src/logger/app-logger";
import { OutputBus, type OutputEvent, type OutputSink } from "../src/output";

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

  it("marks diagnostic events on the bus while normal logs stay unmarked", () => {
    const bus = new OutputBus();
    const events = collect(bus);
    const logger = new Logger("info", "agent", bus);

    logger.diagnostic("warn", "hallucination retry 1/3");
    logger.warn("user-facing notice");

    expect(events[0]).toMatchObject({
      level: "warn",
      kind: "log",
      text: "hallucination retry 1/3",
      data: { diagnostic: true },
    });
    expect(events[1].data).toBeUndefined();
  });
});

describe("Logger file-only logging", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-logger-unit-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes logSilent/logStructured to app.jsonl without emitting to the bus", () => {
    const bus = new OutputBus();
    const events = collect(bus);
    const logger = new Logger("debug", "", bus);
    logger.setLogDir(dir);

    logger.logSilent("warn", "silent-msg");
    logger.logStructured("env", { a: 1 });

    const content = readFileSync(join(dir, "app.jsonl"), "utf-8");
    expect(content).toContain("silent-msg");
    expect(content).toContain('"type":"env"');
    expect(events).toHaveLength(0);
  });

  it("diagnostic() flags the bus event and still appends to app.jsonl", () => {
    const bus = new OutputBus();
    const events = collect(bus);
    const logger = new Logger("info", "agent", bus);
    logger.setLogDir(dir);

    logger.diagnostic("warn", "empty response on iteration 3");

    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ diagnostic: true });
    expect(readFileSync(join(dir, "app.jsonl"), "utf-8")).toContain(
      "empty response on iteration 3",
    );
  });

  it("still writes to files when the injected sink throws", () => {
    const throwingSink: OutputSink = {
      emit() {
        throw new Error("sink exploded");
      },
    };
    const logger = new Logger("info", "", throwingSink);
    logger.setLogDir(dir);

    expect(() => logger.info("throwing-sink")).not.toThrow();

    expect(existsSync(join(dir, "app.jsonl"))).toBe(true);
    expect(readFileSync(join(dir, "app.jsonl"), "utf-8")).toContain("throwing-sink");

    const logPath = logger.getLogPath();
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf-8")).toContain("throwing-sink");
  });
});
