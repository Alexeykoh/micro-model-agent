import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LspModule } from "../src/modules/lsp/module";

describe("LspModule", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lsp-test-"));
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it("passes a project root resolved with the server's workspaceMarkers", async () => {
	const baseDir = join(tmp, "nested");
	const srcDir = join(baseDir, "src");
	mkdirSync(srcDir, { recursive: true });
	writeFileSync(join(baseDir, "tsconfig.json"), "{}");
	writeFileSync(join(srcDir, "a.ts"), "export const a = 1;", "utf-8");

	const module = new LspModule({ enabled: true } as any);
	const plugin = module.getPlugin();
	const result = { success: true, output: "ok" };
	let receivedProjectRoot: string | null = null;
	(module as any).client.checkFile = async (
		_filePath: string,
		_baseDirArg: string,
		_config: unknown,
		projectRoot: string,
	) => {
		receivedProjectRoot = projectRoot;
		return [];
	};
	await plugin.onAfterTool!(
		{ baseDir, logger: { warn: () => {} } } as any,
		{ name: "write_file", arguments: { path: "src/a.ts" } },
		result,
	);
	expect(receivedProjectRoot).toBe(baseDir);
});

  it("appends an LSP check failed note when the server cannot start", async () => {
    const baseDir = join(tmp, "proj");
    const srcDir = join(baseDir, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "a.ts"), "export const a = 1;", "utf-8");

    const module = new LspModule({ enabled: true } as any);
    const plugin = module.getPlugin();
    const result = { success: true, output: "file written ok" };
    const ctx = {
      baseDir,
      logger: { warn: () => {} },
    } as any;
    (module as any).client.checkFile = async () => {
      throw new Error("npx typescript-language-server not found");
    };
    await plugin.onAfterTool!(
      ctx,
      { name: "write_file", arguments: { path: "src/a.ts" } },
      result,
    );
    expect(result.output).toContain("[LSP check failed]");
  });
});
