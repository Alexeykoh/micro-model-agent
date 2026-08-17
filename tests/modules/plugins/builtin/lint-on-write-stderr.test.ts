import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { LintOnWritePlugin } from "../../../../src/modules/plugins/builtin/lint-on-write";

describe("LintOnWritePlugin — stderr detail", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-lint-stderr-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runWrite(path: string) {
    const plugin = new LintOnWritePlugin();
    const mockCtx = {
      baseDir: tmpDir,
      logger: { debug: () => {}, warn: () => {} },
    } as any;
    const result: any = { success: true, output: "File written" };
    const call: any = { name: "write_file", arguments: { path } };
    return plugin.onAfterTool!(mockCtx, call, result).then(() => result);
  }

  it("appends stderr detail when the lint script fails", async () => {
    const pkg = {
      scripts: {
        lint: 'node -e "console.error(\'LINT_ERR_MSG_MARKER\');process.exit(1)"',
      },
    };
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(tmpDir, "x.ts"), "export const x: number = 1;\n");

    const result = await runWrite("x.ts");
    expect(result.output).toContain("[Project lint failed]");
    expect(result.output).toContain("LINT_ERR_MSG_MARKER");
  });
});
