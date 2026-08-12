import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Auditor } from "../src/modules/execution/auditor";
import { PlanCreator } from "../src/modules/execution/planner";

describe("Auditor", () => {
	let tmpDir: string;
	let auditor: Auditor;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "mma-audit-"));
		auditor = new Auditor(tmpDir);
	});

	afterEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
	});

	it("should pass when all step files exist", async () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/index.ts"), "");
		writeFileSync(join(tmpDir, "src/utils.ts"), "");

		const plan = PlanCreator.createPlan(
			"test",
			[
				"Create src/index.ts file with content",
				"Create src/utils.ts file with content",
			],
			tmpDir,
		);
		plan.steps[0].status = "done";
		plan.steps[1].status = "done";

		const result = await auditor.audit(plan);
		expect(result.passed).toBe(true);
		expect(result.missingFiles).toEqual([]);
	});

	it("should fail when files missing", async () => {
		const plan = PlanCreator.createPlan(
			"test",
			[
				"Create src/index.ts with real content",
				"Create src/missing.ts with content",
			],
			tmpDir,
		);
		plan.steps[0].status = "done";
		plan.steps[1].status = "done";

		const result = await auditor.audit(plan);
		expect(result.passed).toBe(false);
		expect(result.missingFiles.length).toBeGreaterThan(0);
	});

	it("should not treat JS member access (process.env) as a missing file", async () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src", "check-env.ts"), "");

		const plan = PlanCreator.createPlan(
			"test",
			[
				"Create src/check-env.ts reading process.env.NODE_ENV",
				"Log with console.log and exit via process.exit(1)",
			],
			tmpDir,
		);
		plan.steps[0].status = "done";
		plan.steps[1].status = "done";

		const result = await auditor.audit(plan);
		expect(result.passed).toBe(true);
		expect(result.missingFiles).toEqual([]);
	});

	it("should produce summary", async () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/index.ts"), "");

		const plan = PlanCreator.createPlan(
			"test",
			["Create src/index.ts with main function"],
			tmpDir,
		);
		plan.steps[0].status = "done";

		const result = await auditor.audit(plan);
		expect(result.summary).toMatch(/complete/i);
	});

	it("should warn on mass edit (>10 files)", async () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		const files = Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`);
		files.forEach((f) => writeFileSync(join(tmpDir, f), ""));

		const plan = PlanCreator.createPlan(
			"test",
			files.map((f) => `Create ${f}`),
			tmpDir,
		);
		plan.steps.forEach((s) => (s.status = "done"));

		const result = await auditor.audit(plan);
		expect(result.massEditWarning).toBeTruthy();
		expect(result.massEditWarning).toContain("15");
	});

	it("should not warn on small edit (<=10 files)", async () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/index.ts"), "");

		const plan = PlanCreator.createPlan(
			"test",
			["Create src/index.ts"],
			tmpDir,
		);
		plan.steps[0].status = "done";

		const result = await auditor.audit(plan);
		expect(result.massEditWarning).toBeNull();
	});
});

describe("Auditor test-run verification (R4)", () => {
	let tmpDir: string;
	let auditor: Auditor;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "mma-audit-tests-"));
		auditor = new Auditor(tmpDir);
	});

	afterEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
	});

	it("fails the audit when a test step exists and tests actually fail", async () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/util.ts"), "export const add = (a: number, b: number) => a + b;\n");
		mkdirSync(join(tmpDir, "test"), { recursive: true });
		writeFileSync(
			join(tmpDir, "test", "util.test.ts"),
			`import { describe, it, expect } from "bun:test";
import { add } from "../src/util";
describe("util", () => {
  it("adds", () => { expect(add(1, 2)).toBe(3); });
  it("fails", () => { expect(add(1, 2)).toBe(42); });
});\n`,
		);

		const plan = PlanCreator.createPlan(
			"test",
			["Create src/util.ts with add function", "Run tests with bun test"],
			tmpDir,
		);
		plan.steps[0].status = "done";
		plan.steps[1].status = "done";

		const result = await auditor.audit(plan);
		expect(result.passed).toBe(false);
		expect(result.testRun).not.toBeNull();
		expect(result.testRun!.checked).toBe(true);
		expect(result.testRun!.failed).toBeGreaterThan(0);
		expect(result.summary).toContain("FAILING");
	});

	it("passes the audit when tests all pass", async () => {
		mkdirSync(join(tmpDir, "test"), { recursive: true });
		writeFileSync(
			join(tmpDir, "test", "ok.test.ts"),
			`import { describe, it, expect } from "bun:test";
describe("ok", () => { it("passes", () => { expect(1).toBe(1); }); });\n`,
		);

		const plan = PlanCreator.createPlan(
			"test",
			["Create test/ok.test.ts", "Run tests via bun test"],
			tmpDir,
		);
		plan.steps[0].status = "done";
		plan.steps[1].status = "done";

		const result = await auditor.audit(plan);
		expect(result.passed).toBe(true);
		expect(result.testRun).not.toBeNull();
		expect(result.testRun!.failed).toBe(0);
	});

	it("does not run tests when no step mentions testing", async () => {
		// A failing test file exists, but the plan never mentions tests —
		// the audit must not run bun test (and must not fail on it).
		mkdirSync(join(tmpDir, "test"), { recursive: true });
		writeFileSync(
			join(tmpDir, "test", "bad.test.ts"),
			`import { describe, it, expect } from "bun:test";
describe("bad", () => { it("fails", () => { expect(1).toBe(2); }); });\n`,
		);
		writeFileSync(join(tmpDir, "src.ts"), "export const x = 1;\n");

		const plan = PlanCreator.createPlan(
			"test",
			["Create src.ts with content"],
			tmpDir,
		);
		plan.steps[0].status = "done";

		const result = await auditor.audit(plan);
		expect(result.passed).toBe(true);
		expect(result.testRun).toBeNull();
	});
});
