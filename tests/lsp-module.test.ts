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

  it("disables LSP for the session after N consecutive failures and says so once", async () => {
    const baseDir = join(tmp, "proj2");
    const srcDir = join(baseDir, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "a.ts"), "export const a = 1;", "utf-8");

    const module = new LspModule({ enabled: true } as any);
    const plugin = module.getPlugin();
    const ctx = {
      baseDir,
      logger: { warn: () => {} },
    } as any;
    (module as any).client.checkFile = async () => {
      throw new Error("server not found");
    };

    // First two failures: keep the per-write note (existing behavior).
    for (let i = 0; i < 2; i++) {
      const r = { success: true, output: "file written ok" };
      await plugin.onAfterTool!(
        ctx,
        { name: "write_file", arguments: { path: "src/a.ts" } },
        r,
      );
      expect(r.output).toContain("[LSP check failed]");
    }

    // Third consecutive failure: one clear "unavailable" signal + disable.
    const third = { success: true, output: "file written ok" };
    await plugin.onAfterTool!(
      ctx,
      { name: "write_file", arguments: { path: "src/a.ts" } },
      third,
    );
    expect(third.output).toContain("LSP disabled");
    expect(third.output).toContain("LSP");
    expect(third.output).toContain("unavailable");

    // Fourth and later: no per-write noise, no repeated signal.
    const fourth = { success: true, output: "file written ok" };
    await plugin.onAfterTool!(
      ctx,
      { name: "write_file", arguments: { path: "src/a.ts" } },
      fourth,
    );
    expect(fourth.output).toBe("file written ok");
    expect(module.isLspDisabled()).toBe(true);
  });

  it("does not disable after an isolated failure followed by a success", async () => {
    const baseDir = join(tmp, "proj3");
    const srcDir = join(baseDir, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "a.ts"), "export const a = 1;", "utf-8");

    const module = new LspModule({ enabled: true } as any);
    const plugin = module.getPlugin();
    const ctx = {
      baseDir,
      logger: { warn: () => {} },
    } as any;

    let shouldFail = true;
    (module as any).client.checkFile = async () => {
      if (shouldFail) throw new Error("boom");
      return [];
    };

    // fail once
    const r1 = { success: true, output: "ok" };
    await plugin.onAfterTool!(
      ctx,
      { name: "write_file", arguments: { path: "src/a.ts" } },
      r1,
    );
    expect(r1.output).toContain("[LSP check failed]");

    // succeed — resets the consecutive-failure counter
    shouldFail = false;
    const r2 = { success: true, output: "ok" };
    await plugin.onAfterTool!(
      ctx,
      { name: "write_file", arguments: { path: "src/a.ts" } },
      r2,
    );
    expect(module.isLspDisabled()).toBe(false);

    // fail twice more — still under the threshold because of the reset
    shouldFail = true;
    const r3 = { success: true, output: "ok" };
    await plugin.onAfterTool!(
      ctx,
      { name: "write_file", arguments: { path: "src/a.ts" } },
      r3,
    );
    const r4 = { success: true, output: "ok" };
    await plugin.onAfterTool!(
      ctx,
      { name: "write_file", arguments: { path: "src/a.ts" } },
      r4,
    );
    expect(module.isLspDisabled()).toBe(false);
  });
});
