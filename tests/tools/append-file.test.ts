import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { appendFileTool } from "../../src/tools/append-file";
import type { ToolContext } from "../../src/tools/types";
import type { AppConfig } from "../../src/config/types";

let TEST_DIR: string;

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    config: {} as AppConfig,
    baseDir: TEST_DIR,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    sessionId: "test-session",
    fileOperationsCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), "mma-append-file-"));
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe("append_file tool", () => {
  it("has the correct definition", () => {
    expect(appendFileTool.name).toBe("append_file");
    expect(appendFileTool.parameters.required).toEqual(["path", "content"]);
  });

  it("appends to an existing file without overwriting", async () => {
    const file = join(TEST_DIR, "log.txt");
    writeFileSync(file, "A", "utf-8");

    const ctx = makeCtx();
    const result = await appendFileTool.handler(ctx, { path: "log.txt", content: "B" });

    expect(result.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("AB");
  });

  it("creates a missing file and parent directories", async () => {
    const ctx = makeCtx();
    const result = await appendFileTool.handler(ctx, {
      path: "sub/new.txt",
      content: "hello",
    });

    expect(result.success).toBe(true);
    const file = join(TEST_DIR, "sub", "new.txt");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("hello");
  });

  it("blocks a path outside the write allowlist", async () => {
    mkdirSync(join(TEST_DIR, "allowed"), { recursive: true });
    const other = join(TEST_DIR, "other.txt");

    const ctx = makeCtx({ writePathAllowlist: [join(TEST_DIR, "allowed")] });
    const result = await appendFileTool.handler(ctx, { path: "other.txt", content: "x" });

    expect(result.success).toBe(false);
    expect(existsSync(other)).toBe(false);
  });
});
