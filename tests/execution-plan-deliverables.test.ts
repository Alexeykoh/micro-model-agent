import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExecutionModule } from "../src/modules/execution/module";

function planTool(execModule: ExecutionModule) {
	return execModule.getToolDefinitions().find((t) => t.name === "plan")!;
}

describe("plan update deliverable gate", () => {
	let tmpDir: string;
	let execModule: ExecutionModule;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "mma-plan-deliv-"));
		execModule = new ExecutionModule(tmpDir, 8);
	});

	afterEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
	});

	it("blocks marking a step done when its named file does not exist", async () => {
		const tool = planTool(execModule);
		const ctx: any = {};

		const created = await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Create src/bicycles.ts with content"],
		});
		expect(created.success).toBe(true);

		const res = await tool.handler(ctx, {
			action: "update",
			step: 1,
			status: "done",
		});
		expect(res.success).toBe(false);
		expect(res.output).toContain("bicycles.ts");
		expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");
	});

	it("blocks marking done when the file was just deleted", async () => {
		// Regression (ses_msstxxff): `del bicycles.ts` then
		// `plan update step=2 status=done` while the file was gone — the step
		// was self-certified and the audit gate passed.
		const tool = planTool(execModule);
		const ctx: any = {};
		await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Download images", "Replace emoji in bicycles.ts with links"],
		});
		await tool.handler(ctx, { action: "update", step: 1, status: "done" });

		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src", "bicycles.ts"), "export const x = 1;\n");
		rmSync(join(tmpDir, "src", "bicycles.ts"));

		const res = await tool.handler(ctx, {
			action: "update",
			step: 2,
			status: "done",
		});
		expect(res.success).toBe(false);
		expect(execModule.getTracker()!.getStep(2)!.status).not.toBe("done");
	});

	it("allows marking done once the named file exists (even nested)", async () => {
		const tool = planTool(execModule);
		const ctx: any = {};
		await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Create src/bicycles.ts"],
		});

		// File lives in a nested project dir relative to baseDir.
		mkdirSync(join(tmpDir, "bicycle-shop", "src"), { recursive: true });
		writeFileSync(
			join(tmpDir, "bicycle-shop", "src", "bicycles.ts"),
			"export const x = 1;\n",
		);

		const res = await tool.handler(ctx, {
			action: "update",
			step: 1,
			status: "done",
		});
		expect(res.success).toBe(true);
		expect(execModule.getTracker()!.getStep(1)!.status).toBe("done");
	});

	it("allows marking done when a step has no file tokens (pure command)", async () => {
		const tool = planTool(execModule);
		const ctx: any = {};
		await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Run bun build and verify no errors"],
		});
		const res = await tool.handler(ctx, {
			action: "update",
			step: 1,
			status: "done",
		});
		expect(res.success).toBe(true);
	});

	it("does not treat URL hostnames as missing deliverables", async () => {
		const tool = planTool(execModule);
		const ctx: any = {};
		await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Add git remote https://example.com/repo.git"],
		});
		const res = await tool.handler(ctx, {
			action: "update",
			step: 1,
			status: "done",
		});
		expect(res.success).toBe(true);
	});

	it("still enforces the order gate before the deliverable gate", async () => {
		const tool = planTool(execModule);
		const ctx: any = {};
		await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Create src/a.ts", "Create src/b.ts"],
		});

		const res = await tool.handler(ctx, {
			action: "update",
			step: 2,
			status: "done",
		});
		expect(res.success).toBe(false);
		expect(res.output).not.toContain("deliverables");
		expect(execModule.getTracker()!.getStep(2)!.status).not.toBe("done");
	});

	it("keeps blocking done when the named file does not exist (strict gate)", async () => {
		// The deliverable gate must NOT become fuzzy (no plural/singular or
		// substring matching). A step naming a non-existent file stays blocked;
		// the documented escape hatch is status=skipped.
		const tool = planTool(execModule);
		const ctx: any = {};
		await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Create src/type.ts with the Bicycle type"],
		});
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		// Real file has a different name — gate must still refuse.
		writeFileSync(join(tmpDir, "src", "types.ts"), "export interface Bicycle {}\n");
		const res = await tool.handler(ctx, {
			action: "update",
			step: 1,
			status: "done",
		});
		expect(res.success).toBe(false);
		expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");
	});

	it("allows marking a delete-kind step done once its files are gone", async () => {
		const tool = planTool(execModule);
		const ctx: any = {};
		await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Remove src/AboutPage.js"],
			kinds: ["delete"],
		});
		expect(execModule.getTracker()!.getStep(1)!.kind).toBe("delete");

		// File still exists → blocked.
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src", "AboutPage.js"), "x");
		const blocked = await tool.handler(ctx, {
			action: "update",
			step: 1,
			status: "done",
		});
		expect(blocked.success).toBe(false);
		expect(blocked.output).toContain("AboutPage.js");
		expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");

		// File gone → done accepted.
		rmSync(join(tmpDir, "src", "AboutPage.js"));
		const ok = await tool.handler(ctx, {
			action: "update",
			step: 1,
			status: "done",
		});
		expect(ok.success).toBe(true);
		expect(execModule.getTracker()!.getStep(1)!.status).toBe("done");
	});

	it("rejects an invalid kinds value", async () => {
		const tool = planTool(execModule);
		const ctx: any = {};
		const res = await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Remove src/a.js"],
			kinds: ["explode"],
		});
		expect(res.success).toBe(false);
	});

	it("still blocks done when a create-kind file was just deleted (regression ses_msstxxff)", async () => {
		const tool = planTool(execModule);
		const ctx: any = {};
		await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Replace emoji in bicycles.ts"],
		});
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src", "bicycles.ts"), "export const x = 1;\n");
		rmSync(join(tmpDir, "src", "bicycles.ts"));
		const res = await tool.handler(ctx, {
			action: "update",
			step: 1,
			status: "done",
		});
		expect(res.success).toBe(false);
	});

	it("rejects a non-array kinds value", async () => {
		const tool = planTool(execModule);
		const ctx: any = {};
		const res = await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Remove src/a.js"],
			kinds: "delete",
		});
		expect(res.success).toBe(false);
	});

	it("blocks a delete-kind step when only one of several files still exists", async () => {
		const tool = planTool(execModule);
		const ctx: any = {};
		await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Remove src/a.js and src/b.js"],
			kinds: ["delete"],
		});
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src", "a.js"), "x");
		const res = await tool.handler(ctx, {
			action: "update",
			step: 1,
			status: "done",
		});
		expect(res.success).toBe(false);
		expect(res.output).toContain("a.js");
	});

	it("keeps kinds when rebuilding the plan via update with steps", async () => {
		const tool = planTool(execModule);
		const ctx: any = {};
		await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Create src/x.ts"],
		});
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src", "x.ts"), "x");
		const res = await tool.handler(ctx, {
			action: "update",
			title: "T2",
			steps: ["Remove src/x.ts"],
			kinds: ["delete"],
		});
		expect(res.success).toBe(true);
		expect(execModule.getTracker()!.getStep(1)!.kind).toBe("delete");
		// Still blocked while the file exists (delete semantics kept).
		const blocked = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
		expect(blocked.success).toBe(false);
		expect(blocked.output).toContain("x.ts");
		// Gone → done accepted.
		rmSync(join(tmpDir, "src", "x.ts"));
		const ok = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
		expect(ok.success).toBe(true);
	});

	it("auto-advances a delete-kind step only once its files are gone (inversion of create-kind)", async () => {
		// advancePlanIfStepComplete fires on write/edit success, which the plan
		// tool handler does not trigger — drive it through the public plugin
		// hook, not a private method.
		const tool = planTool(execModule);
		const ctx: any = {};
		await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Remove src/old.js"],
			kinds: ["delete"],
		});
		const plugin = execModule.getPlugin();
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src", "old.js"), "x");
		const fakeCall: any = { name: "edit_file", arguments: { path: "src/old.js" } };
		// File still exists → a successful write/edit must NOT auto-advance
		// (create-kind semantics inverted for delete).
		plugin.onAfterTool({}, fakeCall, { success: true, output: "ok" });
		expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");
		// File gone → the same write/edit signal auto-advances.
		rmSync(join(tmpDir, "src", "old.js"));
		plugin.onAfterTool({}, fakeCall, { success: true, output: "ok" });
		expect(execModule.getTracker()!.getStep(1)!.status).toBe("done");
	});

	it("auto-advance ignores extension-only tokens so a delete step cannot skip past live files", async () => {
		// Regression (0.36 branch): advancePlanIfStepComplete extracted step file
		// tokens with the raw \b[\w./\\-]+\.[a-z]+ regex, so a description like
		// "Удалить все .js дубликаты, оставить только .tsx/.ts" produced the phantom
		// token "tsx/.ts" (from ".tsx/.ts") which never exists — allGone was
		// trivially true and the delete step auto-advanced on the next successful
		// write even while the real files to delete (src/dup.js) still existed.
		// The shared extractFileLikeTokens rejects extension-only segments, so
		// the step stays pending while the real file is on disk.
		const tool = planTool(execModule);
		const ctx: any = {};
		await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Удалить все .js дубликаты, оставить только .tsx/.ts"],
			kinds: ["delete"],
		});
		const plugin = execModule.getPlugin();
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src", "dup.js"), "x");

		const ctx2: any = {
			contextManager: { addMessage: () => {} },
			sessionLog: { plan: () => {} },
		};
		const call: any = { name: "write_file", arguments: { path: "src/other.ts" } };
		const result: any = { success: true, output: "Written src/other.ts" };

		// Real file still present → a successful write must NOT auto-advance the
		// delete step (the extension-only token must be filtered out).
		plugin.onAfterTool(ctx2, call, result);
		expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");

		// With no concrete file token left in the description, auto-advance has
		// nothing to verify and stays pending even after the real file is gone
		// (the phantom tsx/.ts is filtered out, not resolved to a live path).
		rmSync(join(tmpDir, "src", "dup.js"));
		plugin.onAfterTool(ctx2, call, result);
		expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");

		// The step is still completable explicitly: with no named deliverables
		// left, the delete gate is vacuous and plan update accepts done.
		const ok = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
		expect(ok.success).toBe(true);
		expect(execModule.getTracker()!.getStep(1)!.status).toBe("done");
	});
});
