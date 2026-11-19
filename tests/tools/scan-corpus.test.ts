import { beforeAll, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCorpusTool } from "../../src/tools/scan-corpus";
import { setLocale } from "../../src/i18n/index";
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
  beforeAll(() => setLocale("en"));

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

  it("fails without a path", async () => {
    const res = await scanCorpusTool.handler(
      baseCtx(process.cwd(), { allowed_files: [], read_only_files: [] }),
      { question: "q", path: "" },
    );
    expect(res.success).toBe(false);
  });

  it("fails without an LLM provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-sc-"));
    try {
      writeFileSync(join(dir, "a.md"), "alpha content", "utf8");
      const ctx = { ...baseCtx(dir, { allowed_files: [dir], read_only_files: [] }), llmProvider: undefined };
      const res = await scanCorpusTool.handler(ctx, { question: "q", path: dir });
      expect(res.success).toBe(false);
      expect(res.output).not.toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a protected file inside an in-scope directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-sc-"));
    try {
      writeFileSync(join(dir, ".env"), "SECRET_TOKEN=leak", "utf8");
      writeFileSync(join(dir, "ok.md"), "ordinary content", "utf8");
      const res = await scanCorpusTool.handler(
        baseCtx(dir, { allowed_files: [dir], read_only_files: [] }),
        { question: "what is here?", path: dir },
      );
      expect(res.success).toBe(true);
      // Только ok.md дошёл до модели; .env отфильтрован как protected.
      expect(res.output).toContain("1 file(s)");
      expect(res.output).not.toContain("SECRET_TOKEN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates an invalid max_fanout (NaN) and still succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-sc-"));
    try {
      writeFileSync(join(dir, "a.md"), "alpha content", "utf8");
      const res = await scanCorpusTool.handler(
        baseCtx(dir, { allowed_files: [dir], read_only_files: [] }),
        { question: "what is here?", path: dir, max_fanout: Number.NaN },
      );
      expect(res.success).toBe(true);
      expect(res.output).toContain("1 file(s)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks the output as truncated when the 200-file cap is hit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-sc-"));
    try {
      for (let i = 0; i < 201; i++) {
        writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.md`), `content ${i}`, "utf8");
      }
      const res = await scanCorpusTool.handler(
        baseCtx(dir, { allowed_files: [dir], read_only_files: [] }),
        { question: "what is here?", path: dir, max_fanout: 32 },
      );
      expect(res.success).toBe(true);
      expect(res.output).toContain("200 file(s)");
      expect(res.output).toContain("truncated");
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
