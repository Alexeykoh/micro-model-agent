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