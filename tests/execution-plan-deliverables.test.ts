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
});
