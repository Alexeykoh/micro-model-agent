import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileTool } from "../../src/tools/write-file";
import { deleteFileTool } from "../../src/tools/delete-file";
import { moveFileTool } from "../../src/tools/move-file";
import { createDirTool } from "../../src/tools/create-dir";
import type { ToolContext } from "../../src/tools/types";

/**
 * Allowlist записи (`ctx.writePathAllowlist`) действует для ВСЕХ мутирующих
 * тулов (аудит §4.4, план `2026-10-12-harness-module-audit-fixes`, W3/Task 3.3).
 * Раньше проверка жила только в write_file/append_file/edit_file.
 */

const root = mkdtempSync(join(tmpdir(), "mma-write-allowlist-"));
const allowed = join(root, "AGENTS.md");
writeFileSync(allowed, "# agents\n", "utf-8");
const secret = join(root, "src", "important.ts");
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(secret, "export const x = 1;\n", "utf-8");

function makeCtx(allowlist: string[]): ToolContext {
  return {
    baseDir: root,
    config: {},
    logger: { info: () => {}, error: () => {} },
    writePathAllowlist: allowlist,
  } as unknown as ToolContext;
}

describe("write allowlist: все мутирующие тулы", () => {
  it("write_file", async () => {
    const res = await writeFileTool.handler(makeCtx([allowed]), {
      path: secret,
      content: "x",
    });
    expect(res.success).toBe(false);
  });

  it("delete_file", async () => {
    const res = await deleteFileTool.handler(makeCtx([allowed]), { path: secret });
    expect(res.success).toBe(false);
  });

  it("move_file (источник)", async () => {
    const res = await moveFileTool.handler(makeCtx([allowed]), {
      from: secret,
      to: join(root, "moved.ts"),
    });
    expect(res.success).toBe(false);
  });

  it("move_file (приёмник)", async () => {
    const res = await moveFileTool.handler(makeCtx([allowed]), {
      from: allowed,
      to: join(root, "src", "other.ts"),
    });
    expect(res.success).toBe(false);
  });

  it("create_dir", async () => {
    const res = await createDirTool.handler(makeCtx([allowed]), {
      path: join(root, "src", "new-dir"),
    });
    expect(res.success).toBe(false);
  });

  it("путь из allowlist — можно", async () => {
    const dir = join(root, "allowed-dir");
    const res = await createDirTool.handler(makeCtx([dir]), { path: dir });
    expect(res.success).toBe(true);
  });
});
