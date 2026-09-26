import { describe, expect, it } from "bun:test";
import {
  buildSessionJson,
  buildSessionJsonl,
  extensionFor,
  formatExport,
  redactExport,
  renderSessionMarkdown,
  sanitizeFileName,
} from "../../src/modules/session/export";
import type { SessionMeta, SessionMessage } from "../../src/modules/session/types";

const meta: SessionMeta = {
  id: "ses_test_1234567890",
  name: "my session",
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T01:00:00.000Z",
  messageCount: 2,
  model: "qwen/qwen3.5-9b",
  contextWindow: 32768,
  projectDir: "E:/projects/demo",
};

const messages: SessionMessage[] = [
  { role: "user", content: "hello", timestamp: "2026-09-22T00:00:01.000Z" },
  { role: "assistant", content: "hi there", timestamp: "2026-09-22T00:00:02.000Z" },
];

describe("session export formatters", () => {
  it("renders markdown with metadata and turns", () => {
    const md = renderSessionMarkdown(meta, messages);
    expect(md).toContain("# my session (ses_test_1234567890)");
    expect(md).toContain("## User");
    expect(md).toContain("hello");
    expect(md).toContain("## Assistant");
    expect(md).toContain("hi there");
  });

  it("builds parseable json", () => {
    const json = buildSessionJson(meta, messages);
    const parsed = JSON.parse(json);
    expect(parsed.meta.id).toBe(meta.id);
    expect(parsed.messages).toHaveLength(2);
  });

  it("builds jsonl, one entry per line", () => {
    const jsonl = buildSessionJsonl([
      { ts: "t1", type: "user", content: "a" },
      { ts: "t2", type: "assistant", content: "b" },
    ]);
    const lines = jsonl.split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe("user");
  });

  it("formatExport dispatches on format", () => {
    expect(formatExport({ meta, messages, log: [] }, "json")).toContain('"messages"');
    expect(formatExport({ meta, messages, log: [] }, "md")).toContain("## User");
  });

  it("redacts recognizable secrets only when enabled", () => {
    const secret = "token sk-abcdefghijklmnop123456";
    expect(redactExport(secret, true)).toContain("sk-[REDACTED]");
    expect(redactExport(secret, false)).toBe(secret);
  });

  it("sanitizes file names", () => {
    expect(sanitizeFileName("my session: v1/2")).toBe("my-session-v1-2");
    expect(sanitizeFileName("   ")).toBe("session");
  });

  it("maps formats to extensions", () => {
    expect(extensionFor("md")).toBe("md");
    expect(extensionFor("json")).toBe("json");
    expect(extensionFor("jsonl")).toBe("jsonl");
  });

  it("compact md drops tool bodies but keeps tool_call lines", () => {
    const withTools: SessionMessage[] = [
      ...messages,
      {
        role: "assistant",
        content: "running",
        timestamp: "2026-09-22T00:00:03.000Z",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "bash", arguments: "{}" } },
        ],
      } as SessionMessage,
      { role: "tool", name: "bash", content: "line1\nline2\nline3", timestamp: "2026-09-22T00:00:04.000Z" },
    ];
    const full = renderSessionMarkdown(meta, withTools);
    expect(full).toContain("## Tool");
    expect(full).toContain("line1");
    const compact = renderSessionMarkdown(meta, withTools, { compact: true });
    expect(compact).not.toContain("## Tool");
    expect(compact).not.toContain("line1");
    expect(compact).toContain("tool_call");
    expect(compact).toContain("## User");
  });

  it("compact json drops tool messages, compact jsonl drops snapshots", () => {
    const withTools: SessionMessage[] = [
      ...messages,
      { role: "tool", name: "bash", content: "bulk", timestamp: "2026-09-22T00:00:04.000Z" },
    ];
    const parsed = JSON.parse(buildSessionJson(meta, withTools, { compact: true }));
    expect(parsed.messages).toHaveLength(2);

    const jsonl = buildSessionJsonl(
      [
        { ts: "t1", type: "user", content: "a" },
        { ts: "t2", type: "context", content: "snapshot" },
        { ts: "t3", type: "tool_result", content: "bulk" },
        { ts: "t4", type: "llm_usage", content: "tokens" },
        { ts: "t5", type: "assistant", content: "b" },
      ],
      { compact: true },
    );
    const types = jsonl.split("\n").map((l) => JSON.parse(l).type);
    expect(types).toEqual(["user", "assistant"]);
  });
});
