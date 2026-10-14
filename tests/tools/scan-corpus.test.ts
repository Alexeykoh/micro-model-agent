import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCorpusTool } from "../../src/tools/scan-corpus";
import type { Message } from "../../src/llm/provider";

function mockProvider() {
  return {
    chat: async function* (messages: Message[]) {
      const user = messages.find((m) => m.role === "user")?.content as string;
      yield { type: "text", content: user.includes("Text:") ? "CHUNK_ANSWER" : "SYNTH" };
    },
  };
}

const baseCtx = (dir: string, scope: { allowed_files: string[]; read_only_files: string[] }) =>
  ({
    baseDir: dir,
    scope,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    llmProvider: mockProvider() as any,
    config: {
      subagent: { maxParallelChunkQueries: 2 },
    },
  }) as any;

describe("scanCorpusTool", () => {
  it("has correct definition", () => {
    expect(scanCorpusTool.name).toBe("scan_corpus");
    expect(scanCorpusTool.parameters.required).toContain("question");
    expect(scanCorpusTool.parameters.required).toContain("path");
    expect(scanCorpusTool.tags).toContain("research");
  });

  it("fails without a question", async () => {
    const res = await scanCorpusTool.handler(
      baseCtx(process.cwd(), { allowed_files: [], read_only_files: [] }),
      { question: "", path: "src" },
    );
    expect(res.success).toBe(false);
  });

  it("rejects a path outside the base/scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-sc-"));
    const outside = join(tmpdir(), "mma-sc-outside-does-not-exist");
    try {
      const res = await scanCorpusTool.handler(
        baseCtx(dir, { allowed_files: [dir], read_only_files: [] }),
        { question: "q", path: outside },
      );
      expect(res.success).toBe(false);
      expect(res.output).toContain("SCOPE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans a temp dir of files and returns the synthesis", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-sc-"));
    try {
      writeFileSync(join(dir, "a.md"), "alpha content", "utf8");
      writeFileSync(join(dir, "b.md"), "beta content", "utf8");
      const res = await scanCorpusTool.handler(
        baseCtx(dir, { allowed_files: [dir], read_only_files: [] }),
        { question: "what is here?", path: dir },
      );
      expect(res.success).toBe(true);
      expect(res.output).toContain("SYNTH");
      expect(res.output).toContain("2 file(s)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
