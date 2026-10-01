import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { editFileTool } from "../src/tools/edit-file";

describe("edit_file", () => {
  let tmpDir: string;
  let ctx: any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-test-"));
    ctx = { baseDir: tmpDir, config: {}, logger: { info: () => {}, error: () => {} } };
    writeFileSync(join(tmpDir, "test.txt"), "hello world");
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true });
  });

  it("should replace text in file", async () => {
    const result = await editFileTool.handler(ctx, {
      path: join(tmpDir, "test.txt"),
      old: "world",
      new: "there",
    });
    expect(result.success).toBe(true);
    expect(readFileSync(join(tmpDir, "test.txt"), "utf-8")).toBe("hello there");
  });

  it("should return error when string not found", async () => {
    const result = await editFileTool.handler(ctx, {
      path: join(tmpDir, "test.txt"),
      old: "nonexistent",
      new: "x",
    });
    expect(result.success).toBe(false);
  });

  it("hints to read the file first when the string is not found", async () => {
    // Regression (ses_msyghz8w): a wrong edit_file target string made the
    // agent retry the same edit blind. The error must tell it to read_file.
    const result = await editFileTool.handler(ctx, {
      path: join(tmpDir, "test.txt"),
      old: "nonexistent",
      new: "x",
    });
    expect(result.output).toContain("read_file");
    expect(result.output).toContain("test.txt");
  });

  it("should enforce path safety", async () => {
    const result = await editFileTool.handler(ctx, { path: "../outside.txt", old: "x", new: "y" });
    expect(result.success).toBe(false);
  });

  it("treats regex replacement tokens in `new` literally (no $& expansion)", async () => {
    writeFileSync(join(tmpDir, "tpl.txt"), "price is 100");
    const result = await editFileTool.handler(ctx, {
      path: join(tmpDir, "tpl.txt"),
      old: "price is 100",
      new: "cost is $& $1 $' literally",
    });
    expect(result.success).toBe(true);
    expect(readFileSync(join(tmpDir, "tpl.txt"), "utf-8")).toBe("cost is $& $1 $' literally");
  });

  it("rejects non-string old/new instead of coercing to 'null'/'undefined'", async () => {
    const result = await editFileTool.handler(ctx, {
      path: join(tmpDir, "test.txt"),
      old: null,
      new: { nested: true },
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("old");
    // Файл не должен быть изменён.
    expect(readFileSync(join(tmpDir, "test.txt"), "utf-8")).toBe("hello world");
  });

  it("matches LF anchors in a CRLF file (ses_mup6p61q)", async () => {
    // Windows checkout: файл с \r\n, модель шлёт якорь с \n.
    // Раньше — «Строка не найдена», ~22 провала за сессию.
    writeFileSync(join(tmpDir, "crlf.txt"), "line1\r\nline2\r\nline3\r\n");
    const result = await editFileTool.handler(ctx, {
      path: join(tmpDir, "crlf.txt"),
      old: "line1\nline2",
      new: "one\ntwo",
    });
    expect(result.success).toBe(true);
    // Окончания строк файла сохранены, вставка — в стиле файла.
    expect(readFileSync(join(tmpDir, "crlf.txt"), "utf-8")).toBe("one\r\ntwo\r\nline3\r\n");
  });

  it("keeps LF style in LF files and still fails on truly absent anchors", async () => {
    writeFileSync(join(tmpDir, "lf.txt"), "a\nb\nc\n");
    const ok = await editFileTool.handler(ctx, {
      path: join(tmpDir, "lf.txt"),
      old: "a\nb",
      new: "x\ny",
    });
    expect(ok.success).toBe(true);
    expect(readFileSync(join(tmpDir, "lf.txt"), "utf-8")).toBe("x\ny\nc\n");

    const miss = await editFileTool.handler(ctx, {
      path: join(tmpDir, "lf.txt"),
      old: "nope\nnothing",
      new: "z",
    });
    expect(miss.success).toBe(false);
    expect(miss.output).toContain("read_file");
  });
});
