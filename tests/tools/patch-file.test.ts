// AQC-6: патч малыми hunk'ами вместо перезаписи всего файла кусками.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { patchFileTool } from "../../src/tools/patch-file";

describe("patch_file", () => {
  let tmp: string;
  let ctx: any;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mma-patch-"));
    ctx = { baseDir: tmp, config: {}, logger: { info: () => {}, error: () => {} } };
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("применяет несколько правок за один вызов", async () => {
    const file = join(tmp, "a.ts");
    writeFileSync(file, "export const a = 1;\nexport const b = 2;\n");
    const res = await patchFileTool.handler(ctx, {
      path: file,
      edits: [
        { old: "const a = 1", new: "const a = 10" },
        { old: "const b = 2", new: "const b = 20" },
      ],
    });
    expect(res.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("export const a = 10;\nexport const b = 20;\n");
    expect(res.diff).toBeTruthy();
  });

  it("не меняет файл, если якорь не найден", async () => {
    const file = join(tmp, "a.ts");
    writeFileSync(file, "export const a = 1;\n");
    const res = await patchFileTool.handler(ctx, {
      path: file,
      edits: [{ old: "const missing", new: "x" }],
    });
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/not found|не найден/);
    expect(readFileSync(file, "utf-8")).toBe("export const a = 1;\n");
  });

  it("проверяет синтаксис один раз после всех правок", async () => {
    const file = join(tmp, "a.ts");
    writeFileSync(file, "export const a = 1;\n");
    const res = await patchFileTool.handler(ctx, {
      path: file,
      edits: [{ old: "const a = 1", new: "const a = (" }],
    });
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/syntax error|Синтаксическая ошибка/i);
    expect(readFileSync(file, "utf-8")).toBe("export const a = 1;\n");
  });
});
