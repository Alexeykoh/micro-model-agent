import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildEvidencePack, isWorkMutation } from "../src/modules/critic/evidence";

describe("critic evidence", () => {
  it("detects work mutations", () => {
    expect(isWorkMutation("write_file")).toBe(true);
    expect(isWorkMutation("edit_file")).toBe(true);
    expect(isWorkMutation("bash")).toBe(true);
    expect(isWorkMutation("read_file")).toBe(false);
    expect(isWorkMutation("plan")).toBe(false);
  });

  it("collects changed files, commands and a bounded digest", () => {
    const pack = buildEvidencePack({
      task: "fix bug",
      planSummary: "step 1 -> done",
      toolEvents: [
        { tool: "write_file", args: { path: "src/a.ts" }, ok: true },
        { tool: "bash", args: { command: "bun test" }, ok: false },
        { tool: "read_file", args: { path: "src/a.ts" }, ok: true },
      ],
    });
    expect(pack.changedFiles).toContain("src/a.ts");
    expect(pack.commands[0]).toEqual({ command: "bun test", exitCode: 1 });
    expect(pack.toolDigest.split("\n")).toHaveLength(3);
  });

  it("attaches bash and failure outputs to digest and commands", () => {
    const pack = buildEvidencePack({
      task: "run tests",
      toolEvents: [
        { tool: "bash", args: { command: "bun test" }, ok: false, output: "FAIL foo\n1 fail" },
        { tool: "read_file", args: { path: "src/a.ts" }, ok: true, output: "export const a = 1;" },
      ],
    });
    expect(pack.toolDigest).toContain("FAIL foo");
    expect(pack.commands[0].output).toContain("FAIL foo");
    // Successful non-bash output stays out of the digest (budget).
    expect(pack.toolDigest).not.toContain("export const a");
  });

  describe("file excerpts", () => {
    let tmpDir = "";
    afterEach(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    });

    it("reads back changed files when baseDir is provided", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "mma-critic-exc-"));
      mkdirSync(join(tmpDir, "src"), { recursive: true });
      writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
      const pack = buildEvidencePack({
        task: "create file",
        baseDir: tmpDir,
        toolEvents: [{ tool: "write_file", args: { path: "src/a.ts" }, ok: true }],
      });
      expect(pack.fileExcerpts).toHaveLength(1);
      expect(pack.fileExcerpts![0].path).toBe("src/a.ts");
      expect(pack.fileExcerpts![0].excerpt).toContain("export const a");
    });

    it("skips missing files and omits excerpts without baseDir", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "mma-critic-exc-"));
      const withDir = buildEvidencePack({
        task: "t",
        baseDir: tmpDir,
        toolEvents: [{ tool: "write_file", args: { path: "nope.ts" }, ok: true }],
      });
      expect(withDir.fileExcerpts).toEqual([]);
      const withoutDir = buildEvidencePack({
        task: "t",
        toolEvents: [{ tool: "write_file", args: { path: "nope.ts" }, ok: true }],
      });
      expect(withoutDir.fileExcerpts).toBeUndefined();
    });
  });

  describe("answer excerpt", () => {
    it("carries the chat answer for mutation-free turns", () => {
      const pack = buildEvidencePack({
        task: "покажи пример кода react",
        toolEvents: [],
        answerText: "```tsx\nexport function TodoList() {}\n```",
      });
      expect(pack.answerExcerpt).toContain("TodoList");
    });

    it("omits the excerpt without answer text", () => {
      const pack = buildEvidencePack({ task: "fix bug", toolEvents: [] });
      expect(pack.answerExcerpt).toBeUndefined();
    });

    it("caps length and redacts recognizable secrets", () => {
      const pack = buildEvidencePack({
        task: "t",
        toolEvents: [],
        answerText: `key sk-abcdefghijklmnopqrstuvwx here\n${"x".repeat(5000)}`,
      });
      expect(pack.answerExcerpt).not.toContain("sk-abcdefghijklmnopqrstuvwx");
      expect(pack.answerExcerpt).toContain("sk-[REDACTED]");
      expect(pack.answerExcerpt!.length).toBeLessThanOrEqual(2000);
    });
  });
});
