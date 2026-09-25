import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ContextLogger,
  serializeContextForLog,
  unifiedDiff,
  redactContextSecrets,
} from "../src/core/agent/context-log";
import type { ContextLoggerOptions } from "../src/core/agent/context-log";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-context-log-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

const tools = [{ name: "read_file", description: "Read a file", parameters: { path: "string" } }];

function logger(path: string, overrides: Partial<ContextLoggerOptions> = {}) {
  return new ContextLogger({
    path,
    sessionId: "ses_test",
    model: "qwen3.5-9b",
    contextWindow: 32768,
    runId: 1234,
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    ...overrides,
  });
}

describe("redactContextSecrets", () => {
  it("redacts recognizable secrets", () => {
    expect(redactContextSecrets("sk-abcdefghijklmnopqrstuvwxyz012345")).toContain("sk-[REDACTED]");
    expect(redactContextSecrets("ghp_012345678901234567890123456789012345")).toContain("ghp_[REDACTED]");
    expect(redactContextSecrets("api_key=abcdefghijklmnop")).toContain("[REDACTED]");
    expect(redactContextSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123")).toContain(
      "Bearer [REDACTED]",
    );
  });

  it("does not corrupt ordinary context text", () => {
    const text = [
      'pass "background: true"',
      "pass a file to check it",
      "Use when finishing-a-development-branch",
      "verification-before-completion",
      "Arguments to pass to the tool",
    ].join("\n");
    const out = redactContextSecrets(text);
    expect(out).toBe(text);
    expect(out).not.toContain("[REDACTED]");
  });
});

describe("serializeContextForLog", () => {
  it("emits system, tools and history sections", () => {
    const text = serializeContextForLog(
      [
        { role: "system", content: "You are MMA." },
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
        },
        { role: "tool", content: "line1\nline2", tool_call_id: "c1", success: true },
      ],
      tools,
    );

    expect(text).toContain("[SYSTEM]");
    expect(text).toContain("You are MMA.");
    expect(text).toContain("[TOOLS]");
    expect(text).toContain("read_file | Read a file");
    expect(text).toContain("[HISTORY]");
    expect(text).toContain("role=user");
    expect(text).toContain("hello");
    expect(text).toContain("→ read_file");
    expect(text).toContain("role=tool id=c1 success=true");
    expect(text).toContain("line1\nline2");
  });

  it("marks empty history", () => {
    const text = serializeContextForLog([{ role: "system", content: "sys" }], []);
    expect(text).toContain("(empty)");
    expect(text).toContain("(none)");
  });
});

describe("unifiedDiff", () => {
  it("returns empty for identical input", () => {
    expect(unifiedDiff("a\nb", "a\nb")).toBe("");
  });

  it("shows added, removed and changed lines", () => {
    const diff = unifiedDiff("a\nb\nc", "a\nx\nc\nd");
    expect(diff).toContain("--- a");
    expect(diff).toContain("+++ b");
    expect(diff).toContain("-b");
    expect(diff).toContain("+x");
    expect(diff).toContain("+d");
    expect(diff).toContain("@@");
  });

  it("handles pure append with a single prefix context", () => {
    const diff = unifiedDiff("a\nb", "a\nb\nc");
    expect(diff).toContain("+c");
    // No removed content line (the `--- a` header is not a removed line).
    expect(diff).not.toMatch(/^-[^-]/m);
  });

  it("does not throw on large inputs (fallback path)", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    expect(() => unifiedDiff(big, `${big}\nextra`)).not.toThrow();
  });
});

describe("ContextLogger", () => {
  it("writes a full first snapshot with '+' lines", () => {
    const path = join(tmpDir(), "context.diff");
    const log = logger(path);
    log.record(
      [{ role: "system", content: "You are MMA." }],
      tools,
      { iteration: 1, ts: "2026-09-19T10:00:00Z", systemTokens: 3, toolTokens: 2, historyTokens: 0, totalTokens: 5, contextWindow: 32768 },
    );

    const out = readFileSync(path, "utf8");
    expect(out).toContain("mma context log");
    expect(out).toContain("### snapshot 0");
    expect(out).toContain("--- /dev/null");
    expect(out).toContain("+++ b/context@0");
    expect(out).toContain("+[SYSTEM]");
    expect(out).toContain("+You are MMA.");
  });

  it("writes a diff for later snapshots", () => {
    const path = join(tmpDir(), "context.diff");
    const log = logger(path);
    const meta = { iteration: 1, ts: "2026-09-19T10:00:00Z", systemTokens: 1, toolTokens: 1, historyTokens: 0, totalTokens: 2, contextWindow: 32768 };

    log.record([{ role: "system", content: "sys" }], [], meta);
    log.record(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "do the thing" },
      ],
      [],
      { ...meta, iteration: 2 },
    );

    const out = readFileSync(path, "utf8");
    expect(out).toContain("### snapshot 1");
    expect(out).toContain("+role=user");
    expect(out).toContain("+do the thing");
    expect(out).toContain("--- context@0");
    expect(out).toContain("+++ context@1");
  });

  it("appends a run separator when the file already has content", () => {
    const path = join(tmpDir(), "context.diff");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "old content\n", "utf8");

    const log = logger(path, { runId: 777 });
    log.record([{ role: "system", content: "sys" }], [], {
      iteration: 1, ts: "t", systemTokens: 1, toolTokens: 0, historyTokens: 0, totalTokens: 1, contextWindow: 32768,
    });

    const out = readFileSync(path, "utf8");
    expect(out).toContain("old content");
    expect(out).toContain("===== run 777");
    // First snapshot of the run is full again.
    expect(out).toContain("--- /dev/null");
  });

  it("continues snapshot numbering across runs", () => {
    const path = join(tmpDir(), "context.diff");
    const first = logger(path);
    first.record([{ role: "user", content: "a" }], [], {
      iteration: 1, ts: "t", systemTokens: 0, toolTokens: 0, historyTokens: 1, totalTokens: 1, contextWindow: 32768,
    });

    const second = logger(path);
    second.record([{ role: "user", content: "b" }], [], {
      iteration: 1, ts: "t", systemTokens: 0, toolTokens: 0, historyTokens: 1, totalTokens: 1, contextWindow: 32768,
    });

    const out = readFileSync(path, "utf8");
    expect(out).toContain("### snapshot 1");
  });

  it("writes [OUTPUT] reasoning as an annotation", () => {
    const path = join(tmpDir(), "context.diff");
    const log = logger(path);
    log.record([{ role: "user", content: "hi" }], [], {
      iteration: 1, ts: "t", systemTokens: 0, toolTokens: 0, historyTokens: 1, totalTokens: 1, contextWindow: 32768,
    });
    log.recordOutput({
      iteration: 1,
      ts: "t",
      reasoning: "I should read the file",
      text: "Reading now",
      toolCalls: [{ name: "read_file", arguments: { path: "a.ts" } }],
    });

    const out = readFileSync(path, "utf8");
    expect(out).toContain("[OUTPUT #1");
    expect(out).toContain("NOT part of the LLM context");
    expect(out).toContain("▍reasoning:");
    expect(out).toContain("I should read the file");
    expect(out).toContain("▍assistant text:");
    expect(out).toContain("▍tool_calls:");
  });

  it("skips empty output annotations", () => {
    const path = join(tmpDir(), "context.diff");
    const log = logger(path);
    log.record([{ role: "user", content: "hi" }], [], {
      iteration: 1, ts: "t", systemTokens: 0, toolTokens: 0, historyTokens: 1, totalTokens: 1, contextWindow: 32768,
    });
    log.recordOutput({ iteration: 1, ts: "t", reasoning: "   " });

    const out = readFileSync(path, "utf8");
    expect(out).not.toContain("[OUTPUT #");
  });

  it("redacts secrets by default", () => {
    const path = join(tmpDir(), "context.diff");
    const log = logger(path);
    log.record([{ role: "user", content: "api_key=sk-abcdefghijklmnopqrstuvwxyz012345" }], [], {
      iteration: 1, ts: "t", systemTokens: 0, toolTokens: 0, historyTokens: 1, totalTokens: 1, contextWindow: 32768,
    });

    const out = readFileSync(path, "utf8");
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(out).toContain("[REDACTED]");
  });

  it("can disable redaction", () => {
    const path = join(tmpDir(), "context.diff");
    const log = logger(path, { redact: false });
    log.record([{ role: "user", content: "api_key=sk-abcdefghijklmnopqrstuvwxyz012345" }], [], {
      iteration: 1, ts: "t", systemTokens: 0, toolTokens: 0, historyTokens: 1, totalTokens: 1, contextWindow: 32768,
    });

    const out = readFileSync(path, "utf8");
    expect(out).toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  });
});
