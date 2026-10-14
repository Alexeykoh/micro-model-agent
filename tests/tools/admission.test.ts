import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitFromContext, admitToolResult } from "../../src/tools/admission";
import { estimateTokens } from "../../src/llm/token-counter";
import type { ToolContext } from "../../src/tools/types";
import type { Diagnostic } from "../../src/output/types";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-admit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("admitToolResult", () => {
  it("passes small output through untouched", () => {
    const r = admitToolResult(
      { success: true, output: "hello" },
      { baseDir: dir, sessionId: "s1", maxTokens: 3000 },
    );
    expect(r.output).toBe("hello");
    expect(r.artifactPath).toBeUndefined();
  });

  it("spills large output and returns a descriptor with a preview", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const r = admitToolResult(
      { success: true, output: big },
      { baseDir: dir, sessionId: "s1", maxTokens: 3000, source: "big.txt" },
    );
    expect(r.output).not.toContain("line 4999");
    expect(r.output).toContain("big.txt");
    expect(r.output).toContain("line 0");
    expect(r.artifactPath).toBeTruthy();
    expect(readFileSync(r.artifactPath as string, "utf8")).toBe(big);
  });

  it("does not admit failed results", () => {
    const big = "x".repeat(100000);
    const r = admitToolResult(
      { success: false, output: big },
      { baseDir: dir, sessionId: "s1", maxTokens: 100 },
    );
    expect(r.output).toBe(big);
    expect(r.artifactPath).toBeUndefined();
  });

  it("distinct artifact paths for consecutive admissions, both files intact", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    // Пинаем Date.now: оба вызова в одну «миллисекунду», уникальность даёт UUID-суффикс.
    const spy = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      const a = admitToolResult(
        { success: true, output: big },
        { baseDir: dir, sessionId: "s1", maxTokens: 3000 },
      );
      const b = admitToolResult(
        { success: true, output: big },
        { baseDir: dir, sessionId: "s1", maxTokens: 3000 },
      );
      expect(a.artifactPath).toBeTruthy();
      expect(b.artifactPath).toBeTruthy();
      expect(a.artifactPath).not.toBe(b.artifactPath);
      expect(readFileSync(a.artifactPath as string, "utf8")).toBe(big);
      expect(readFileSync(b.artifactPath as string, "utf8")).toBe(big);
    } finally {
      spy.mockRestore();
    }
  });

  it("char-bounds preview for a single huge line", () => {
    const big = "x".repeat(100000);
    const r = admitToolResult(
      { success: true, output: big },
      { baseDir: dir, sessionId: "s1", maxTokens: 100 },
    );
    expect(r.output.length).toBeLessThan(3000);
    expect(r.output).toContain("…");
  });

  it("does not spill output exactly at the token threshold", () => {
    const text = "a".repeat(100); // estimateTokens → 25
    expect(estimateTokens(text)).toBe(25);
    const r = admitToolResult(
      { success: true, output: text },
      { baseDir: dir, sessionId: "s1", maxTokens: 25 },
    );
    expect(r.output).toBe(text);
    expect(r.artifactPath).toBeUndefined();
  });

  it("respects a custom spillDir", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const r = admitToolResult(
      { success: true, output: big },
      { baseDir: dir, sessionId: "s1", maxTokens: 3000, spillDir: "custom/dir" },
    );
    expect(r.artifactPath).toBeTruthy();
    expect(existsSync(r.artifactPath as string)).toBe(true);
    expect((r.artifactPath as string).startsWith(join(dir, "custom", "dir", "s1"))).toBe(true);
  });

  it("falls back to default spill dir when spillDir escapes baseDir", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const r = admitToolResult(
      { success: true, output: big },
      { baseDir: dir, sessionId: "s1", maxTokens: 3000, spillDir: "../../evil" },
    );
    expect(r.artifactPath).toBeTruthy();
    expect((r.artifactPath as string).startsWith(join(dir, ".mma", "context", "s1"))).toBe(true);
    expect(existsSync(r.artifactPath as string)).toBe(true);
  });

  it("throws when sessionId escapes baseDir", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    expect(() =>
      admitToolResult(
        { success: true, output: big },
        { baseDir: dir, sessionId: "../../../evil", maxTokens: 3000 },
      ),
    ).toThrow(/escapes baseDir/);
  });

  it("sets a short tool-name-free display when admitted", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const r = admitToolResult(
      { success: true, output: big },
      { baseDir: dir, sessionId: "s1", maxTokens: 3000 },
    );
    expect(r.display).toBeTruthy();
    expect(r.display).toContain("5000");
    // Дескриптор в `output` содержит имена тулов; display — нет (STYLE: чат).
    expect(r.display).not.toContain("read_file");
    expect(r.display).not.toContain("chunk_query");
    expect(r.output).toContain("read_file");
  });

  it("is terminal: does not re-admit an already-admitted result", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const first = admitToolResult(
      { success: true, output: big },
      { baseDir: dir, sessionId: "s1", maxTokens: 3000 },
    );
    expect(first.artifactPath).toBeTruthy();
    // Дескриптор сам длиннее 5 токенов — без terminal-гейта получился бы
    // дескриптор-из-дескриптора.
    const second = admitToolResult(first, {
      baseDir: dir,
      sessionId: "s1",
      maxTokens: 5,
    });
    expect(second).toEqual(first);
    expect(second.output).toBe(first.output);
    expect(second.artifactPath).toBe(first.artifactPath);
  });

  it("spilled artifact supports a bounded re-read slice", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const r = admitToolResult(
      { success: true, output: big },
      { baseDir: dir, sessionId: "s1", maxTokens: 3000 },
    );
    expect(r.artifactPath).toBeTruthy();
    expect(existsSync(r.artifactPath as string)).toBe(true);
    // read_file-подобный offset/limit: первые 20 строк — узкий, полный.
    const slice = (readFileSync(r.artifactPath as string, "utf8"))
      .split("\n")
      .slice(0, 20)
      .join("\n");
    expect(slice).toBe(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
    expect(slice.length).toBeLessThan(big.length);
  });

  it("admitFromContext is best-effort: raw output kept, diagnostic emitted", () => {
    // baseDir — обычный файл, поэтому mkdirSync бросает ENOTDIR.
    const notADir = join(dir, "plain-file");
    writeFileSync(notADir, "x");
    const big = "L".repeat(40000);
    const warns: string[] = [];
    const diags: Diagnostic[] = [];
    const ctx = {
      baseDir: notADir,
      sessionId: "s1",
      logger: { warn: (m: string) => warns.push(m) },
      onDiagnostic: (d: Diagnostic) => diags.push(d),
    } as unknown as ToolContext;
    const r = admitFromContext({ success: true, output: big }, ctx, {
      id: "1",
      name: "big_tool",
      arguments: {},
    });
    expect(r.output).toBe(big);
    expect(r.artifactPath).toBeUndefined();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("admission skipped");
    // INV-15: fail-open путь оставляет различимый сигнал.
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      source: "tool:admission",
      operation: "admit",
      kind: "degraded",
      recoverable: true,
    });
    expect(diags[0].cause.length).toBeGreaterThan(0);
  });
});
