import { describe, it, expect } from "vitest";
import { parseChunks } from "../src/llm/response";
import type { Chunk } from "../src/llm/provider";

describe("parseChunks", () => {
  it("should parse text chunks", () => {
    const chunks: Chunk[] = [
      { type: "text", content: "Hello " },
      { type: "text", content: "world" },
      { type: "done", finishReason: "stop" },
    ];
    const result = parseChunks(chunks);
    expect(result.type).toBe("text");
    if (result.type === "text") {
      expect(result.content).toBe("Hello world");
    }
  });

  it("should parse tool_call chunks", () => {
    const chunks: Chunk[] = [
      { type: "text", content: "I will read the file" },
      {
        type: "tool_call",
        toolCall: { id: "call_1", name: "read_file", arguments: '{"path":"test.txt"}' },
      },
      { type: "done", finishReason: "tool_calls" },
    ];
    const result = parseChunks(chunks);
    expect(result.type).toBe("tool_call");
    if (result.type === "tool_call") {
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].name).toBe("read_file");
      expect(result.calls[0].arguments).toEqual({ path: "test.txt" });
    }
  });

  it("should parse reasoning chunks", () => {
    const chunks: Chunk[] = [
      { type: "reasoning", content: "Let me think..." },
      { type: "text", content: "Answer" },
      { type: "done", finishReason: "stop" },
    ];
    const result = parseChunks(chunks);
    expect(result.type).toBe("text");
    if (result.type === "text") {
      expect(result.reasoning).toBe("Let me think...");
    }
  });

  it("should handle empty chunks", () => {
    const result = parseChunks([]);
    expect(result.type).toBe("empty");
  });

  it("should handle multiple tool calls", () => {
    const chunks: Chunk[] = [
      {
        type: "tool_call",
        toolCall: { id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' },
      },
      {
        type: "tool_call",
        toolCall: { id: "call_2", name: "grep", arguments: '{"pattern":"test"}' },
      },
      { type: "done", finishReason: "tool_calls" },
    ];
    const result = parseChunks(chunks);
    expect(result.type).toBe("tool_call");
    if (result.type === "tool_call") {
      expect(result.calls).toHaveLength(2);
    }
  });
});
