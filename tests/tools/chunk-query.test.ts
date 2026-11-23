import { describe, it, expect, beforeEach } from "vitest";
import { setLocale } from "../../src/i18n/index";
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

// Локаль процессная: english-строки сообщений фиксируем явно.
beforeEach(() => setLocale("en"));

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
    expect((chunkQueryTool.parameters.properties as Record<string, unknown>).max_chunks).toBeDefined();
  });

  it("refuses a run that would fan out into too many chunks", async () => {
    const res = await chunkQueryTool.handler(baseCtx("/tmp"), {
      query: "q",
      text: "x".repeat(2_500),
      chunk_chars: 100,
    });
    expect(res.success).toBe(false);
    expect(res.output).toContain("too many chunks");
    expect(res.output).toContain("chunk_chars");
  });

  it("allows an explicitly raised chunk budget", async () => {
    const res = await chunkQueryTool.handler(baseCtx("/tmp"), {
      query: "q",
      text: "x".repeat(2_500),
      chunk_chars: 100,
      max_chunks: 30,
    });
    expect(res.success).toBe(true);
  });

  it("fails without input", async () => {
    const res = await chunkQueryTool.handler(baseCtx("/tmp"), { query: "q" });
    expect(res.success).toBe(false);
  });

  // Проверку пути вне base/скоупа теперь применяет ToolExecutor до хендлера
  // (INV-10) — см. tests/tools/enforcement-path.test.ts.

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
        { query: "count rows", input_path: file, chunk_chars: 100, max_chunks: 20 },
      );
      expect(res.success).toBe(true);
      expect(res.output).toContain("chunk(s)");
      expect(res.output).toContain("SYNTH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
