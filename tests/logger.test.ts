import { describe, it, expect, beforeEach, vi } from "vitest";
import { Logger } from "../src/logger/app-logger";

describe("Logger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should log messages at correct level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new Logger("debug");

    logger.debug("debug msg");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[DEBUG]"));

    logger.info("info msg");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[INFO]"));

    logger.warn("warn msg");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[WARN]"));

    logger.error("error msg");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[ERROR]"));
  });

  it("should filter by log level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new Logger("warn");

    logger.debug("debug msg");
    logger.info("info msg");
    expect(spy).not.toHaveBeenCalled();

    logger.warn("warn msg");
    expect(spy).toHaveBeenCalled();
  });

  it("should format message with metadata", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new Logger("info");

    logger.info("test", { key: "value" });
    const call = spy.mock.calls[0][0] as string;
    expect(call).toContain("[INFO]");
    expect(call).toContain("test");
    expect(call).toContain("key");
  });

  it("should set level dynamically", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new Logger("error");

    logger.setLevel("info");
    logger.info("now visible");
    expect(spy).toHaveBeenCalled();
  });

  it("should create child logger with prefix", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new Logger("info");
    const child = logger.child("tools");

    child.info("hello");
    const call = spy.mock.calls[0][0] as string;
    expect(call).toContain("[tools]");
  });
});
