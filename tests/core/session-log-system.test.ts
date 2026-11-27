import { describe, expect, it } from "vitest";
import { systemEntry } from "../../src/core/session-log-messages";
import { buildRequestSnapshot, SYSTEM_HASH_HEX } from "../../src/llm/request-snapshot";
import { SessionLogger } from "../../src/core/session-logger";
import { Logger } from "../../src/logger/app-logger";
import { SessionManager } from "../../src/modules/session/manager";

describe("system event", () => {
  it("пишет полный промпт, hash и длину; short-note не несёт hash", () => {
    const full = "You are MMA. token: <PATH:deadbeef>".repeat(4);
    const event = systemEntry(full)!;
    expect(event.content).toContain("You are MMA");
    expect(event.content).not.toContain("deadbeef");
    expect(event.chars).toBe(event.content!.length);
    expect(event.sha256).toMatch(new RegExp(`^[0-9a-f]{${SYSTEM_HASH_HEX}}$`));
    const note = systemEntry("[Excluded prompt blocks: 1]", false)!;
    expect(note.sha256).toBeUndefined();
    expect(note.chars).toBeUndefined();
    expect(note.content).toContain("Excluded");
  });

  it("hash и длина простого промпта совпадают со снимком llm_request", () => {
    const text = "You are MMA. Answer briefly.";
    const event = systemEntry(text)!;
    const snap = buildRequestSnapshot(
      { messages: [{ role: "system", content: text }], tools: [] },
      { model: "m", stream: false },
    );
    expect(event.sha256).toBe(snap.systemSha256);
    expect(event.chars).toBe(snap.systemChars);
  });

  it("пустой полный промпт не пишется, короткая пометка остаётся записью", () => {
    expect(systemEntry("")).toBeNull();
    expect(systemEntry("   \n")).toBeNull();
    const note = systemEntry("", false)!;
    expect(note.type).toBe("system");
    expect(note.content).toBe("");
    expect(note.sha256).toBeUndefined();
    expect(note.chars).toBeUndefined();
  });

  it("llm_request можно записать из CLI без webui-моста", () => {
    const records: Array<Record<string, unknown>> = [];
    const manager: SessionManager = Object.assign(Object.create(SessionManager.prototype), {
      getActive: () => "ses_test",
      getActiveMeta: () => null,
      appendLog: (entry: Record<string, unknown>) => records.push(entry),
    });
    const logger: Logger = Object.assign(Object.create(Logger.prototype), { warn: () => {} });
    const slog = new SessionLogger(manager, logger);
    const snap = buildRequestSnapshot(
      { messages: [{ role: "system", content: "S" }], tools: [] },
      { model: "m", stream: false, sessionId: "ses_test" },
    );

    slog.logLlmRequest(snap);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "llm_request", source: "core", llmRequest: snap });
  });

  it("fail-open: сбой записи system не роняет вызов и пишет diagnostic", () => {
    const records: Array<Record<string, unknown>> = [];
    let attempts = 0;
    // Прототип настоящего менеджера, переопределён ровно тот путь, который
    // трогает logSystem: constructor → getActiveMeta, запись → appendLog.
    const manager: SessionManager = Object.assign(Object.create(SessionManager.prototype), {
      getActive: () => "ses_test",
      getActiveMeta: () => null,
      appendLog: (entry: Record<string, unknown>) => {
        attempts += 1;
        if (attempts === 1) throw new Error("disk down");
        records.push(entry);
      },
    });
    const warnings: string[] = [];
    const logger: Logger = Object.assign(Object.create(Logger.prototype), {
      warn: (msg: string) => warnings.push(msg),
    });
    const slog = new SessionLogger(manager, logger);
    expect(() => slog.logSystem("system prompt")).not.toThrow();
    expect(attempts).toBe(2);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "session_degraded",
      source: "core",
      operation: "session.system_log",
      errorKind: "degraded",
      cause: "disk down",
      recoverable: true,
    });
    expect(warnings).toEqual([]);
  });

  it("fail-open до конца: если и диагностика недоступна, остаётся warning", () => {
    const warnings: string[] = [];
    const logger: Logger = Object.assign(Object.create(Logger.prototype), {
      warn: (msg: string) => warnings.push(msg),
    });
    const manager: SessionManager = Object.assign(Object.create(SessionManager.prototype), {
      getActive: () => "ses_test",
      getActiveMeta: () => null,
      appendLog: () => {
        throw new Error("disk down");
      },
    });
    const slog = new SessionLogger(manager, logger);
    expect(() => slog.logSystem("system prompt")).not.toThrow();
    expect(warnings).toContain("system prompt log failed; diagnostic also unavailable");
  });
});
