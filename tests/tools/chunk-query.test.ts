import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkQueryTool } from "../../src/tools/chunk-query";
import type { Message } from "../../src/llm/provider";

function mockProvider() {
  return {
    chat: async function* (messages: Message[]) {
      const user = messages.find((m) => m.role === "user")?.content as string;
      yield { type: "text", content: user.includes("Text:") ? "CHUNK_ANSWER" : "SYNTH" };
    },
  };
}

const baseCtx = (dir: string) =>
  ({
    baseDir: dir,
    scope: { allowed_files: [], read_only_files: [] },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    llmProvider: mockProvider() as any,
    config: {
      subagent: { maxParallelChunkQueries: 2 },
    },
  }) as any;

describe("chunkQueryTool", () => {
  it("has correct definition", () => {
    expect(chunkQueryTool.name).toBe("chunk_query");
    expect(chunkQueryTool.parameters.required).toContain("query");
    expect(chunkQueryTool.tags).toContain("research");
  });

  it("fails without input", async () => {
    const res = await chunkQueryTool.handler(baseCtx("/tmp"), { query: "q" });
    expect(res.success).toBe(false);
  });

  it("rejects paths outside scope", async () => {
    const res = await chunkQueryTool.handler(baseCtx("/tmp"), {
      query: "q",
      input_path: "/etc/passwd",
    });
    expect(res.success).toBe(false);
    expect(res.output).toContain("SCOPE");
  });

  it("answers over a large temp file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-cq-"));
    try {
      const file = join(dir, "big.txt");
      writeFileSync(file, Array.from({ length: 200 }, (_, i) => `row${i}`).join("\n"), "utf8");
      const res = await chunkQueryTool.handler(
        {
          ...baseCtx(dir),
          scope: { allowed_files: [dir], read_only_files: [file] },
        },
        { query: "count rows", input_path: file, chunk_chars: 100 },
      );
      expect(res.success).toBe(true);
      expect(res.output).toContain("chunk(s)");
      expect(res.output).toContain("SYNTH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
