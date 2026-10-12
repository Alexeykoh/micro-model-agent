import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionStore } from "../src/modules/session/store";
import { SessionManager } from "../src/modules/session/manager";
import { SessionLogger } from "../src/core/session-logger";
import type { SessionLogEntry } from "../src/modules/session/store";

describe("SessionLogger provenance", () => {
  let tmpDir: string;
  let store: SessionStore;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-slog-"));
    store = new SessionStore(tmpDir);
    store.init();
    manager = new SessionManager(store, {
      model: "qwen/qwen3.5-9b",
      contextWindow: 32768,
      projectDir: "/test",
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function readLogs(id: string): SessionLogEntry[] {
    const p = join(tmpDir, id, "session.jsonl");
    return readFileSync(p, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SessionLogEntry);
  }

  it("logLlmUsage carries provider and model", () => {
    manager.create("s");
    const id = manager.getActive()!;
    const slog = new SessionLogger(manager, undefined, () => ({
      provider: "zen",
      model: "qwen3.5-9b",
    }));
    slog.logLlmUsage(3, {
      provider: "zen",
      model: "qwen3.5-9b",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      source: "api",
      durationMs: 1200,
    });
    const logs = readLogs(id);
    const usage = logs.find((l) => l.type === "llm_usage")!;
    expect(usage.provider).toBe("zen");
    expect(usage.model).toBe("qwen3.5-9b");
    expect(usage.totalTokens).toBe(150);
  });

  it("logContext carries provider and model", () => {
    manager.create("s");
    const id = manager.getActive()!;
    const slog = new SessionLogger(manager, undefined, () => ({
      provider: "local",
      model: "qwen3.5-9b",
    }));
    slog.logContext({
      kind: "start",
      iteration: 1,
      provider: "local",
      model: "qwen3.5-9b",
      tokens: 100,
      quality: 0.9,
      messageCount: 2,
      compactionCount: 0,
      iterationsSinceCompaction: 1,
    });
    const logs = readLogs(id);
    const ctx = logs.find((l) => l.type === "context")!;
    expect(ctx.provider).toBe("local");
    expect(ctx.model).toBe("qwen3.5-9b");
  });

  it("logToolResult persists provider/model on the history message and tool_result log", () => {
    manager.create("s");
    const id = manager.getActive()!;
    const slog = new SessionLogger(manager, undefined, () => ({
      provider: "router",
      model: "gpt-4o",
    }));
    slog.logToolResult(
      { id: "call_1", name: "read_file", arguments: { path: "/x" } },
      { success: true, output: "ok" },
      10,
      2,
    );
    const logs = readLogs(id);
    const tr = logs.find((l) => l.type === "tool_result")!;
    expect(tr.provider).toBe("router");
    expect(tr.model).toBe("gpt-4o");
    const history = manager.loadHistory(id);
    const toolMsg = history.find((m) => m.role === "tool")!;
    expect(toolMsg.provider).toBe("router");
    expect(toolMsg.model).toBe("gpt-4o");
  });

  it("logAssistant persists provider/model on the history message and assistant log", () => {
    manager.create("s");
    const id = manager.getActive()!;
    const slog = new SessionLogger(manager, undefined, () => ({
      provider: "zen",
      model: "qwen3.5-9b",
    }));
    slog.logAssistant("hello", undefined, undefined, 1);
    slog.saveAssistantMessage("hello");
    const logs = readLogs(id);
    const asst = logs.find((l) => l.type === "assistant")!;
    expect(asst.provider).toBe("zen");
    expect(asst.model).toBe("qwen3.5-9b");
    const history = manager.loadHistory(id);
    const msg = history.find((m) => m.role === "assistant")!;
    expect(msg.provider).toBe("zen");
    expect(msg.model).toBe("qwen3.5-9b");
  });
});

describe("session-logger sanitization", () => {
  const makeLogger = () => {
    const logs: any[] = [];
    const messages: any[] = [];
    const session = {
      getActiveMeta: () => ({ id: "ses_1" }),
      getSessionDirectory: () => "/tmp/nonexistent-mma-ses",
      appendLog: (e: any) => logs.push(e),
      appendMessage: (m: any) => messages.push(m),
    } as any;
    return { logger: new SessionLogger(session), logs, messages };
  };

  it("redacts api keys from logUser", () => {
    const { logger, logs, messages } = makeLogger();
    logger.logUser("my key sk-ABCDEF12345678901234 and token ghp_abcdefghijklmnopqrstuvwxyz1234");
    const all = JSON.stringify({ logs, messages });
    expect(all).not.toContain("sk-ABCDEF12345678901234");
    expect(all).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234");
  });

  it("redacts secrets from logToolCall args and logToolResult output", () => {
    const { logger, logs, messages } = makeLogger();
    logger.logToolCall(
      {
        id: "t1",
        name: "bash",
        arguments: { command: "curl -H 'Authorization: Bearer sk-ABCDEF12345678901234'" },
      },
      1,
    );
    logger.logToolResult(
      { id: "t1", name: "bash", arguments: {} },
      { success: true, output: "token ghp_abcdefghijklmnopqrstuvwxyz1234 leaked" },
      10,
      1,
    );
    const all = JSON.stringify({ logs, messages });
    expect(all).not.toContain("sk-ABCDEF12345678901234");
    expect(all).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234");
  });

  it("persists the full assistant message and tool output (no 500-char cap)", () => {
    const { logger, messages } = makeLogger();
    const long = "The quick brown fox jumps over the lazy dog. ".repeat(40);
    expect(long.length).toBeGreaterThan(500);
    logger.saveAssistantMessage(long);
    logger.logToolResult(
      { id: "t1", name: "read_file", arguments: {} },
      { success: true, output: long },
      10,
      1,
    );
    const assistant = messages.find((m) => m.role === "assistant")!;
    const tool = messages.find((m) => m.role === "tool")!;
    expect(assistant.content).toBe(long);
    expect(tool.content).toBe(long);
  });

  it("redacts secrets from assistant/reasoning/system/error entries", () => {
    const { logger, logs, messages } = makeLogger();
    const secret = "sk-ABCDEF12345678901234";
    logger.logSystem(`system ${secret}`);
    logger.logAssistant(`answer ${secret}`, `reasoning ${secret}`);
    logger.saveAssistantMessage(`final ${secret}`);
    logger.logError({ source: "core", operation: "test.op", kind: "failed", cause: `error ${secret}` });
    const all = JSON.stringify({ logs, messages });
    expect(all).not.toContain(secret);
  });

  it("logError persists the Diagnostic shape (INV-14)", () => {
    const { logger, logs } = makeLogger();
    logger.logError({
      source: "tool:bash",
      operation: "tool.args_parse",
      kind: "degraded",
      cause: "invalid JSON arguments",
      recoverable: true,
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      type: "error",
      source: "tool:bash",
      operation: "tool.args_parse",
      errorKind: "degraded",
      cause: "invalid JSON arguments",
      recoverable: true,
      content: "invalid JSON arguments",
    });
  });

  it("logError without a cause keeps operation as content (kind: ok)", () => {
    const { logger, logs } = makeLogger();
    logger.logError({ source: "core", operation: "probe.context", kind: "ok" });
    expect(logs[0]).toMatchObject({
      type: "error",
      operation: "probe.context",
      errorKind: "ok",
      content: "probe.context",
    });
    expect(logs[0].cause).toBeUndefined();
  });

  it("logToolCall does not throw when sanitizer corrupts the arg JSON", () => {
    // Санитайзер режет закрывающую кавычку в `password=secret"`, из-за чего
    // JSON.parse падал и запись tool_call терялась. Запись обязана выжить.
    const { logger, logs } = makeLogger();
    expect(() =>
      logger.logToolCall(
        { id: "t1", name: "bash", arguments: { cmd: "mysql -p password=secret" } },
        1,
      ),
    ).not.toThrow();
    const entry = logs.find((l) => l.type === "tool_call");
    expect(entry).toBeDefined();
    expect(entry.tool).toBe("bash");
  });

  it("keeps long URLs/slugs in tool args and results (no false redaction)", () => {
    const { logger, logs, messages } = makeLogger();
    const longSlug = "https://catalog.example.com/bike/specialized/rockhopper-27.5-m-2023-gloss-birch";
    logger.logToolCall({ id: "t1", name: "web_fetch", arguments: { url: longSlug } }, 1);
    logger.logToolResult(
      { id: "t1", name: "web_fetch", arguments: {} },
      { success: true, output: `page ${longSlug} fetched` },
      5,
      1,
    );
    const all = JSON.stringify({ logs, messages });
    expect(all).toContain("rockhopper-27.5-m-2023-gloss-birch");
    expect(all).not.toContain("[REDACTED]");
  });

});
