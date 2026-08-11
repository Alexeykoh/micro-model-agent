import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileLogWriter } from "../src/logger/file-log";
import { Logger } from "../src/logger/app-logger";

describe("FileLogWriter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-filelog-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes to a session log file when session is active", () => {
    const writer = new FileLogWriter();
    writer.setLogDir(dir);
    writer.initSessionLog("ses_abc");

    writer.log("INFO", "LLM", "→ model | 5 messages | hello");
    writer.closeSessionLog();

    const file = join(dir, "ses_abc.log");
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("[INFO]");
    expect(content).toContain("[LLM]");
    expect(content).toContain("hello");
  });

  it("writes to a daily log file when no session is active", () => {
    const writer = new FileLogWriter();
    writer.setLogDir(dir);

    writer.log("WARN", "TOOL", "bash | exit:1");

    const date = new Date().toISOString().slice(0, 10);
    const file = join(dir, `${date}.log`);
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("[WARN]");
    expect(content).toContain("[TOOL]");
  });

  it("logs LLM request/response with tags", () => {
    const writer = new FileLogWriter();
    writer.setLogDir(dir);
    writer.initSessionLog("ses_llm");

    writer.logLLMRequest("qwen3.5-9b", 3, "погода в минске", "agent");
    writer.logLLMResponse("qwen3.5-9b", 120, 750, undefined, "agent");
    writer.logLLMResponse("qwen3.5-9b", 0, 50, "timeout", "agent");
    writer.closeSessionLog();

    const content = readFileSync(join(dir, "ses_llm.log"), "utf-8");
    expect(content).toContain("[LLM/agent]");
    expect(content).toContain("→ qwen3.5-9b | 3 messages");
    expect(content).toContain("← qwen3.5-9b | 120 chars | 750ms");
    expect(content).toContain("ERROR: timeout");
  });

  it("logs tool calls with output truncation", () => {
    const writer = new FileLogWriter();
    writer.setLogDir(dir);
    writer.initSessionLog("ses_tool");

    writer.logToolCall("read_file", '{"path":"a.txt"}', "OK");
    writer.logToolOutput("bash", "x".repeat(3000), 0);
    writer.closeSessionLog();

    const content = readFileSync(join(dir, "ses_tool.log"), "utf-8");
    expect(content).toContain("[TOOL]");
    expect(content).toContain("read_file");
    expect(content).toContain("(truncated 1000 chars)");
  });

  it("cleans up old log files by age", () => {
    const writer = new FileLogWriter();
    writer.setLogDir(dir);

    const date = new Date().toISOString().slice(0, 10);
    const oldFile = join(dir, "2020-01-01.log");
    writeFileSync(oldFile, "old");
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(oldFile, past, past);

    writer.cleanupOldLogs(30, 10);

    expect(existsSync(oldFile)).toBe(false);
    // current file written after cleanup still exists
    writer.log("INFO", "MMA", "fresh");
    expect(existsSync(join(dir, `${date}.log`))).toBe(true);
  });

  it("limits the number of log files kept", () => {
    const writer = new FileLogWriter();
    writer.setLogDir(dir);

    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(dir, `file-${i}.log`), "x");
    }

    writer.cleanupOldLogs(30, 2);

    const remaining = readdirSync(dir).filter((f) => f.endsWith(".log"));
    expect(remaining.length).toBeLessThanOrEqual(2);
  });
});

describe("Logger tagged integration", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-logger-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes plain log() calls into the session .log file too", () => {
    const logger = new Logger("info");
    logger.setLogDir(dir);
    logger.initSessionLog("ses_int");

    logger.info("hello from agent");

    const content = readFileSync(join(dir, "ses_int.log"), "utf-8");
    expect(content).toContain("[INFO]");
    expect(content).toContain("hello from agent");
  });

  it("exposes getLogPath pointing at session or daily file", () => {
    const logger = new Logger("info");
    logger.setLogDir(dir);
    expect(logger.getLogPath()).toContain(".log");

    logger.initSessionLog("ses_path");
    expect(logger.getLogPath()).toContain("ses_path.log");
  });
});
