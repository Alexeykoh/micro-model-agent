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

	it("should not treat URL hostnames in step descriptions as missing files", async () => {
		const plan = PlanCreator.createPlan(
			"test",
			[
				"Remove existing origin with git remote remove origin",
				"Add new origin with address https://whom-pointing-jewel-maine.trycloudflare.com/gitea/",
				"Verify result with git remote -v",
			],
			tmpDir,
		);
		plan.steps.forEach((s) => (s.status = "done"));

		const result = await auditor.audit(plan);
		expect(result.missingFiles).toEqual([]);
		expect(result.passed).toBe(true);
	});

	it("should not treat URLs with repo paths as missing files", async () => {
		const plan = PlanCreator.createPlan(
			"test",
			["Push to https://github.com/example/repo.git via git push origin main"],
			tmpDir,
		);
		plan.steps.forEach((s) => (s.status = "done"));

		const result = await auditor.audit(plan);
		expect(result.missingFiles).toEqual([]);
		expect(result.passed).toBe(true);
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

	it("summary must NOT claim completion while steps are pending", async () => {
		// Regression (ses_msstxxff): the gate injected "[✓] Task complete:
		// 1/3 steps done" into context while two steps were still pending,
		// which the model read as a green light to stop working. When all
		// files exist but not every step is done, the summary must say the
		// task is incomplete.
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/index.ts"), "");
		writeFileSync(join(tmpDir, "src/utils.ts"), "");

		const plan = PlanCreator.createPlan(
			"test",
			["Create src/index.ts", "Create src/utils.ts"],
			tmpDir,
		);
		plan.steps[0].status = "done";
		// step 2 left pending on purpose

		const result = await auditor.audit(plan);
		expect(result.summary).not.toMatch(/Task complete/);
		expect(result.summary).not.toContain("[✓]");
		expect(result.summary).toContain("1/2");
	});

	it("summary claims completion only when every step is done", async () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/index.ts"), "");
		writeFileSync(join(tmpDir, "src/utils.ts"), "");

		const plan = PlanCreator.createPlan(
			"test",
			["Create src/index.ts", "Create src/utils.ts"],
			tmpDir,
		);
		plan.steps.forEach((s) => (s.status = "done"));

		const result = await auditor.audit(plan);
		expect(result.summary).toMatch(/complete/i);
		expect(result.summary).toContain("2/2");
	});

	it("should resolve bare filenames in nested project subdirectories", async () => {
		// Plan step mentions "App.tsx" but the file lives at
		// bicycle-shop/src/App.tsx relative to the agent baseDir — the auditor
		// must search the subtree so a completed task is not flagged as
		// "1 files missing" forever (observed in session ses_mssl5izw).
		mkdirSync(join(tmpDir, "bicycle-shop", "src"), { recursive: true });
		writeFileSync(join(tmpDir, "bicycle-shop", "src", "App.tsx"), "");

		const plan = PlanCreator.createPlan(
			"test",
			["Verify App.tsx has <Routes> wrapper around <Route> elements"],
			tmpDir,
		);
		plan.steps[0].status = "done";

		const result = await auditor.audit(plan);
		expect(result.missingFiles).toEqual([]);
		expect(result.passed).toBe(true);
	});

	it("should resolve a partially-prefixed path inside the subtree", async () => {
		// Step description uses "src/App.tsx" while the file is at
		// bicycle-shop/src/App.tsx — suffix matching resolves it.
		mkdirSync(join(tmpDir, "bicycle-shop", "src"), { recursive: true });
		writeFileSync(join(tmpDir, "bicycle-shop", "src", "App.tsx"), "");

		const plan = PlanCreator.createPlan(
			"test",
			["Add <Routes> wrapper in src/App.tsx"],
			tmpDir,
		);
		plan.steps[0].status = "done";

		const result = await auditor.audit(plan);
		expect(result.missingFiles).toEqual([]);
		expect(result.passed).toBe(true);
	});

	it("should not resolve a bare filename when it exists nowhere in the tree", async () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/index.ts"), "");

		const plan = PlanCreator.createPlan(
			"test",
			["Create missing.ts with content"],
			tmpDir,
		);
		plan.steps[0].status = "done";

		const result = await auditor.audit(plan);
		expect(result.missingFiles).toContain("missing.ts");
		expect(result.passed).toBe(false);
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

	it("does not flag files from skipped steps as missing", async () => {
		// ses_mssx0k11: step 1 (prose ref "type.ts", real file types.ts) was
		// skipped; the auditor kept scanning its text and reported "1 files
		// missing" forever even after the model finished the other steps.
		const plan = PlanCreator.createPlan(
			"test",
			[
				"Проверить тип данных Bicycle и поле image в type.ts",
				"Create src/real.ts with content",
			],
			tmpDir,
		);
		plan.steps[0].status = "skipped";
		plan.steps[1].status = "done";
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src", "real.ts"), "export const x = 1;\n");

		const result = await auditor.audit(plan);
		expect(result.missingFiles).toEqual([]);
		expect(result.passed).toBe(true);
	});

	it("treats a skipped step as a terminal complete state (plan with skip passes)", async () => {
		const plan = PlanCreator.createPlan(
			"test",
			["Check nothing", "Create src/a.ts with content"],
			tmpDir,
		);
		plan.steps[0].status = "skipped";
		plan.steps[1].status = "done";
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;\n");

		const result = await auditor.audit(plan);
		expect(result.passed).toBe(true);
		expect(result.summary).not.toContain("not marked done");
	});

	it("still fails when a done step's named file is missing", async () => {
		const plan = PlanCreator.createPlan(
			"test",
			["Create src/missing.ts with content"],
			tmpDir,
		);
		plan.steps[0].status = "done";

		const result = await auditor.audit(plan);
		expect(result.passed).toBe(false);
		expect(result.missingFiles.length).toBeGreaterThan(0);
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
