# Agent Post-Mortem Fixes Implementation Plan

> **Статус:** исполнено (2026-10-20) — `isFilePathLike` отбрасывает extension-only токены,
> удалённые файлы помечаются `[Deleted:]`, session mission + `[User feedback:]`,
> plan-coverage читает реальную задачу, `kind: "create"|"delete"` + инверсия
> deliverable-гейта, аудитор с `leftoverFiles` и реальным `tsc`, hard-stop запрещённых
> Windows-команд. Чекбоксы проставлены по факту.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the agent-loop failures diagnosed from session `ses_mstda6uo` (deletion task spiralled into a typecheck whack-a-mole; task was lost at compaction; plan gate fought the deletion; stale files kept appearing as facts; the model kept calling nonexistent Windows commands).

**Architecture:** Six small, rule-compliant fixes: (1) reject extension-only path tokens, (2) deleted files leave `fileFacts`, (3) session mission survives error-paste user messages, (4) plan-coverage reads the real task, not `<system-summary>`, (5) plan steps get a model-declared `kind: "create" | "delete"` so the deliverable gate inverts for deletion, (6) auditor understands delete-kind steps + runs a real `tsc` typecheck for TS projects, (7) hard-stop repeated forbidden Windows commands in `bash`. No keyword-based task/step-intent classification (AGENTS.md rule #10) — intent is declared by the model (`kind`) or by evidence (tool results, filesystem).

**Tech Stack:** Bun + TypeScript, vitest (`bun test`), strict `tsc --noEmit`.

**Rules honored:** TDD (test first per task, rule #7), no keyword matching for task/step classification (rule #10), i18n for all user-facing strings en+ru (rule #8), small files (rule #1 — new logic that would grow `module.ts` past its current 1061 lines goes to a new `windows-commands.ts`), single source of truth for file-token extraction (rule #4).

**Out of scope (deliberate):**
- `checkPlanAlignment` step gating — the observed block was a mis-designed "confirm" step; the model self-resolved by marking step 1 done. Fixing it needs intent info we get in Task 5; revisit later.
- `plan-coverage.extractFilePaths` still uses its own raw regex. Its main harm (comparing against a `<system-summary>`) is fixed by Task 4. Unifying it is a follow-up.

---

## Task 1: Reject extension-only path tokens (`tsx/.ts`)

**Problem:** A plan step "Проверить что остались только .tsx/.ts файлы" produced token `tsx/.ts` (`FILE_TOKEN_RE`'s `[\w./\\-]+` eats `tsx/`, then `\.ts`), and `isFilePathLike` returned `true` for any token containing a separator — so the deliverable gate demanded "create tsx/.ts".

**Files:**
- Modify: `src/modules/hallucination/js-identifiers.ts:229-239` (`isFilePathLike`)
- Test: `tests/js-identifiers.test.ts`

- [x] **Step 1: Write the failing tests**

Add to `tests/js-identifiers.test.ts` (inside `describe("isFilePathLike")`):

```ts
  it("rejects extension-only path segments (empty stem)", () => {
    expect(isFilePathLike("tsx/.ts")).toBe(false);
    expect(isFilePathLike("src/.env")).toBe(false);
    expect(isFilePathLike(".gitignore")).toBe(false);
    expect(isFilePathLike("dist/app.js.map")).toBe(true);
    expect(isFilePathLike("docs/Report.final")).toBe(true);
  });
```

And inside `describe("extractFileLikeTokens")`:

```ts
  it("extracts no tokens from an extension-list phrase", () => {
    expect(
      extractFileLikeTokens("Проверить что остались только .tsx/.ts файлы"),
    ).toEqual([]);
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/js-identifiers.test.ts`
Expected: FAIL — `isFilePathLike("tsx/.ts")` returns `true` (token with separator is accepted unconditionally).

- [x] **Step 3: Implement**

In `src/modules/hallucination/js-identifiers.ts`, replace the tail of `isFilePathLike`:

```ts
export function isFilePathLike(s: string): boolean {
	const lower = s.toLowerCase();
	if (TECH_NAMES.has(lower)) return false;
	if (isJsMemberAccess(s)) return false;
	const ext = s.split(".").pop()?.toLowerCase() || "";
	if (!s.includes("/") && !s.includes("\\")) {
		if (!/^\w+\.[a-z]{1,6}$/i.test(s)) return false;
		return FILE_EXTENSIONS.has(ext);
	}
	// Tokens with a directory separator: require the LAST segment to carry a
	// real file name (a non-empty stem before the extension). Otherwise an
	// extension-only segment like "tsx/.ts" (from ".tsx/.ts" in a step
	// description) or a dotfile ("src/.env") is misread as a file and the plan
	// deliverable gate demands "create tsx/.ts" (observed in ses_mstda6uo:
	// step "Проверить что остались только .tsx/.ts файлы").
	const last = s.split(/[\\/]/).pop() ?? "";
	const lastDot = last.lastIndexOf(".");
	if (lastDot <= 0) return false;
	return true;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test tests/js-identifiers.test.ts`
Expected: PASS (all cases, including the pre-existing `dist/app.js.map` / `docs/Report.final`).

- [x] **Step 5: Typecheck + commit**

```bash
bun test tests/js-identifiers.test.ts
tsc --noEmit
git add tests/js-identifiers.test.ts src/modules/hallucination/js-identifiers.ts
git commit -m "fix: reject extension-only path tokens (tsx/.ts) in file extraction"
```

---

## Task 2: Deleted files leave `fileFacts`; report them as `[Deleted:]`

**Problem:** `extractFacts` (`manager.ts:397`) pushes `Deleted <path>` into `fileFacts`, so files removed by `delete_file` stayed in every `[Files: ...]` compaction block for the rest of the session. The model believed the `.js` files still existed.

**Files:**
- Modify: `src/modules/context/manager.ts` (field + `extractFacts` + `compact`)
- Test: `tests/context-manager.test.ts`

- [x] **Step 1: Write the failing test**

Add to `tests/context-manager.test.ts` (inside `describe("ContextManager fact extraction")`):

```ts
  it("removes deleted files from the files fact list and reports them as deleted", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "system", content: "SYS" });
    cm.addMessage({
      role: "tool",
      name: "write_file",
      content: "Written src/a.js",
      success: true,
    });
    cm.addMessage({
      role: "tool",
      name: "delete_file",
      content: "Deleted src/a.js",
      success: true,
    });
    for (let i = 0; i < 12; i++) {
      cm.addMessage({ role: "user", content: `more ${i}` });
      cm.addMessage({ role: "assistant", content: `r ${i}` });
    }
    cm.compact();
    const summary = cm
      .getActiveHistory()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(summary).toContain("[Deleted: src/a.js]");
    const filesBlock = summary.match(/\[Files: ([^\]]*)\]/)?.[1] ?? "";
    expect(filesBlock).not.toContain("src/a.js");
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/context-manager.test.ts`
Expected: FAIL — `[Files: src/a.js]` still contains the deleted file and no `[Deleted:]` block exists.

- [x] **Step 3: Implement**

In `src/modules/context/manager.ts`:

3a. Add a field next to `fileFacts` (line ~91):

```ts
	private deletedFacts: string[] = [];
```

3b. Replace the `filePatterns` array inside `extractFacts` (lines ~395-404) with two arrays:

```ts
		const DRIVE = "(?:[a-zA-Z]:[\\\\/])?";
		const createdPatterns = [
			// edit_file returns "Replaced in <path>" — the most common write
			// signal in agent sessions.
			new RegExp(`(?:Created|Updated|Written|Moved|Replaced in) ${DRIVE}([\\w./\\\\-]+\\.[a-z]+)`, "gi"),
			new RegExp(`Файл (?:создан|обновлён|записан|перемещён):? ${DRIVE}([\\w./\\\\-]+\\.[a-z]+)`, "gi"),
			new RegExp(`file (?:created|updated|written|moved):? ${DRIVE}([\\w./\\\\-]+\\.[a-z]+)`, "gi"),
		];
		const deletedPatterns = [
			new RegExp(`Deleted ${DRIVE}([\\w./\\\\-]+\\.[a-z]+)`, "gi"),
			new RegExp(`Файл удалён:? ${DRIVE}([\\w./\\\\-]+\\.[a-z]+)`, "gi"),
		];
```

3c. Change the tool branch of the loop (lines ~423-436) to collect deletions separately:

```ts
		if (msg.role === "tool") {
			for (const pattern of createdPatterns) {
				for (const match of content.matchAll(pattern)) {
					newFiles.push(match[1]);
				}
			}
			for (const pattern of deletedPatterns) {
				for (const match of content.matchAll(pattern)) {
					newDeleted.push(match[1]);
				}
			}

			if (content.includes("Plan:") && content.includes("[")) {
				const planLine = content
					.split("\n")
					.find((line) => line.includes("Plan:"));
				if (planLine) newDecisions.push(planLine.trim());
			}
		}
```

Declare `const newDeleted: string[] = [];` next to `newFiles` (line ~406).

3d. Replace the dedup block at the end of `extractFacts` (lines ~466-476):

```ts
		// Deduplicate and cap facts to prevent unbounded growth. Files that were
		// DELETED leave the "known files" list — a deleted file must not keep
		// being reported as existing (observed: deleted .js files listed in
		// every [Files: ...] block for the whole session).
		const dedup = (arr: string[]): string[] => [...new Set(arr)];
		const deletedSet = new Set(newDeleted);
		this.fileFacts = dedup(
			[...this.fileFacts, ...newFiles].filter((p) => !deletedSet.has(p)),
		).slice(-ContextManager.MAX_FACTS);
		this.deletedFacts = dedup([...this.deletedFacts, ...newDeleted]).slice(
			-ContextManager.MAX_FACTS,
		);
		this.decisionFacts = dedup([...this.decisionFacts, ...newDecisions]).slice(
			-ContextManager.MAX_FACTS,
		);
		this.errorFacts = dedup([...this.errorFacts, ...newErrors]).slice(
			-ContextManager.MAX_FACTS,
		);
```

3e. In `compact()`, filter `fileFacts` against all known deletions and emit `[Deleted:]` (replace the `[Files: ...]` block at lines ~347-349):

```ts
		const deletedSet = new Set(this.deletedFacts);
		const liveFiles = this.fileFacts.filter((p) => !deletedSet.has(p));
		if (liveFiles.length > 0) {
			parts.push(`[Files: ${liveFiles.slice(-15).join("; ")}]`);
		}
		if (this.deletedFacts.length > 0) {
			parts.push(`[Deleted: ${this.deletedFacts.slice(-10).join("; ")}]`);
		}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test tests/context-manager.test.ts`
Expected: PASS (all existing context-manager tests plus the new one).

- [x] **Step 5: Typecheck + commit**

```bash
bun test tests/context-manager.test.ts
tsc --noEmit
git add tests/context-manager.test.ts src/modules/context/manager.ts
git commit -m "fix: drop deleted files from compaction file facts, report as [Deleted:]"
```

---

## Task 3: Session mission survives error-paste user messages

**Problem:** `lastUserTask` is cleared by `resetUserTurn()` and the first non-summary user message of a turn becomes the preserved task. When the user pasted a Vite error block, every subsequent compaction wrote `[Task: [plugin:vite:esbuild] Transform failed...]`, erasing the real goal.

**Fix (message classification, not task classification — rule #10):** a session-level `sessionMission` (first real instruction, never cleared); per-turn `lastUserTask` (real instruction) with fallback to `sessionMission`; error/log paste captured separately as `[User feedback:]` and never allowed to overwrite the task.

**Files:**
- Modify: `src/modules/context/manager.ts`
- Test: `tests/context-manager.test.ts`

- [x] **Step 1: Write the failing test**

Add to `tests/context-manager.test.ts`:

```ts
  it("keeps the original task when the user pastes an error/log block", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "system", content: "SYS" });
    cm.addMessage({ role: "user", content: "удали JS-дубликаты, оставь только .tsx" });
    cm.resetUserTurn();
    const paste = `[plugin:vite:esbuild] Transform failed with 1 error:
E:/projects/mma_tests/bicycle-shop/src/ProductPage.tsx:270:7: ERROR: Multiple exports with the same name "default"

268| export default ProductPage;var _c;$RefreshReg$(_c, "ProductPage");
271| if (import.meta.hot && !inWebWorker) {`;
    cm.addMessage({ role: "user", content: paste });
    for (let i = 0; i < 12; i++) {
      cm.addMessage({ role: "user", content: `t ${i}` });
      cm.addMessage({ role: "assistant", content: `r ${i}` });
    }
    cm.compact();
    const summary = cm
      .getActiveHistory()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(summary).toContain("[Task: удали JS-дубликаты, оставь только .tsx]");
    expect(summary).toContain("[User feedback:");
    expect(summary).not.toContain("[Task: [plugin:vite:esbuild]");
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/context-manager.test.ts`
Expected: FAIL — summary contains `[Task: [plugin:vite:esbuild]...` and not the original task.

- [x] **Step 3: Implement**

In `src/modules/context/manager.ts`:

3a. Add fields (next to `lastUserTask`, line ~95):

```ts
	/** First real user instruction of the session — survives resetUserTurn(). */
	private sessionMission = "";
	/** Latest user message that looks like a pasted error/log (never a task). */
	private lastUserFeedback = "";
```

3b. Add a module-level helper (near `truncate`, line ~51):

```ts
function looksLikeErrorPaste(text: string): boolean {
	if (text.length > 200) return true;
	return /(?:^|\s)ERROR|Error:|error TS\d+|Transform failed|\[plugin:|SyntaxError|Cannot find|Uncaught|exception/i.test(
		text,
	);
}
```

3c. Replace the user-task tracking block in `addMessage` (lines ~205-214):

```ts
	if (msg.role === "user") {
		const text = typeof msg.content === "string" ? msg.content : getMessageText(msg.content);
		if (
			text.trim() &&
			!text.startsWith("<system-summary>") &&
			!text.includes("[Compressed:")
		) {
			if (looksLikeErrorPaste(text)) {
				this.lastUserFeedback = text.trim().slice(0, 400);
			} else if (!this.lastUserTask) {
				this.lastUserTask = text.trim();
				if (!this.sessionMission) this.sessionMission = text.trim();
			}
		}
	}
```

3d. `resetUserTurn()` (lines ~156-161) — clear the per-turn task and feedback but NOT the mission:

```ts
	resetUserTurn(): void {
		this.iterationsSinceCompaction = 0;
		// A new user message begins a new turn — drop the previous turn's task
		// so the fresh instruction becomes the one preserved at compaction. The
		// session mission survives: an error/log paste in the new turn must not
		// erase the original goal.
		this.lastUserTask = "";
		this.lastUserFeedback = "";
	}
```

3e. In `compact()`, emit the task with mission fallback + separate feedback (replace lines ~342-345):

```ts
	const task = (this.lastUserTask || this.sessionMission).slice(0, 400);
	if (task) parts.push(`[Task: ${task}]`);
	if (this.lastUserFeedback && !task.startsWith(this.lastUserFeedback)) {
		parts.push(`[User feedback: ${this.lastUserFeedback}]`);
	}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test tests/context-manager.test.ts`
Expected: PASS — including the pre-existing `resetUserTurn clears the task so a new user message wins` and `does not treat system-summary blocks as the user task`.

- [x] **Step 5: Typecheck + commit**

```bash
bun test tests/context-manager.test.ts
tsc --noEmit
git add tests/context-manager.test.ts src/modules/context/manager.ts
git commit -m "fix: keep the session mission when the user pastes an error/log block"
```

---

## Task 4: Plan-coverage must read the real task, not `<system-summary>`

**Problem:** `getTaskText` (`module.ts:1053-1060`) takes the FIRST user message in history — after compaction that is the `<system-summary>` block, so the plan-coverage warning spammed stale file lists ("Plan may be missing required files from the task: AboutPage.js, App.js...").

**Files:**
- Modify: `src/modules/execution/module.ts` (`getTaskText`)
- Test: `tests/execution-plan-coverage.test.ts`

- [x] **Step 1: Write the failing test**

Add to `tests/execution-plan-coverage.test.ts`:

```ts
import { ExecutionModule } from "../src/modules/execution/module";

function planTool(execModule: ExecutionModule) {
	return execModule.getToolDefinitions().find((t) => t.name === "plan")!;
}

it("does not treat the compacted <system-summary> as the plan task", async () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "mma-coverage-"));
	const execModule = new ExecutionModule(tmpDir, 8);
	try {
		const tool = planTool(execModule);
		const ctx: any = {
			contextManager: {
				getActiveHistory: () => [
					{
						role: "user",
						content:
							"<system-summary>[Compressed: 10 old turns removed] [Files: bicycle-shop/src/ProductPage.js; bicycle-shop/src/AboutPage.js; bicycle-shop/STATUS.md] [Task: удали js-дубликаты]",
					},
				],
			},
		};
		const res = await tool.handler(ctx, {
			action: "create",
			title: "T",
			steps: ["Удалить дубликаты .js из src/"],
		});
		expect(res.success).toBe(true);
		expect(res.output).not.toContain("Plan may be missing required files");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});
```

(Add the imports `mkdtempSync, rmSync` from `fs`, `join` from `path`, `tmpdir` from `os` at the top of the file if not already present — follow the existing imports in `tests/execution-plan-deliverables.test.ts`.)

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/execution-plan-coverage.test.ts`
Expected: FAIL — `res.output` contains `Plan may be missing required files from the task: bicycle-shop/src/ProductPage.js, ...`.

- [x] **Step 3: Implement**

In `src/modules/execution/module.ts`, replace `getTaskText` (lines ~1053-1060):

```ts
	private getTaskText(ctx: any): string {
		const manager = ctx?.contextManager;
		if (!manager) return "";
		const history = manager.getActiveHistory();
		// The first user message may be an injected <system-summary> (compaction
		// block) — it is NOT the task. Coverage must compare the plan against the
		// model's real instruction (observed: a compaction summary's stale file
		// list produced a bogus "plan is missing files" warning).
		const firstUser = history.find((m: { role: string }) => {
			if (m.role !== "user") return false;
			const text = getMessageText(m.content);
			return (
				!text.startsWith("<system-summary>") &&
				!text.includes("[Compressed:")
			);
		});
		if (!firstUser) return "";
		return getMessageText(firstUser.content).trim();
	}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test tests/execution-plan-coverage.test.ts`
Expected: PASS.

- [x] **Step 5: Typecheck + commit**

```bash
bun test tests/execution-plan-coverage.test.ts
tsc --noEmit
git add tests/execution-plan-coverage.test.ts src/modules/execution/module.ts
git commit -m "fix: plan coverage reads the real task, not the compacted system-summary"
```

---

## Task 5: Model-declared `kind` for plan steps (deletion-aware deliverable gate)

**Problem:** The deliverable gate (`missingStepDeliverables`, `module.ts:372-383`) requires named files to EXIST before `done`. For deletion steps this is inverted, so the model could never close them and was forced to `skipped`. Intent is declared by the model (`kinds: ["delete"]`), NOT inferred by keywords — rule #10.

**Files:**
- Modify: `src/modules/execution/planner.ts` (`PlanStep`, `createPlan`, `replan`)
- Modify: `src/modules/execution/module.ts` (plan `create`/`update` handlers, `advancePlanIfStepComplete`, new `stillExistingDeliverables`)
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/execution-plan-deliverables.test.ts`

- [x] **Step 1: Write the failing tests**

Add to `tests/execution-plan-deliverables.test.ts`:

```ts
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
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/execution-plan-deliverables.test.ts`
Expected: FAIL — first test: `done` still blocked after the file is gone; second test: invalid kind accepted; third test: `kinds`/`kind` unknown so `getStep(1)!.kind` is `undefined`.

- [x] **Step 3: Implement**

3a. `src/modules/execution/planner.ts`:

```ts
export type StepKind = "create" | "delete";
```

Add to `PlanStep`:

```ts
export interface PlanStep {
  id: number;
  description: string;
  status: StepStatus;
  /** Model-declared intent. "delete" inverts the deliverable gate: named
   *  files must be GONE, not present. Default "create". */
  kind?: StepKind;
  note?: string;
  subtasks?: Subtask[];
}
```

Update `createPlan` signature and body (lines ~60-77):

```ts
  static createPlan(
    title: string,
    stepDescriptions: string[],
    baseDir: string,
    kinds?: StepKind[],
  ): Plan {
    const stepCount = stepDescriptions.length;
    return {
      id: generatePlanId(),
      title: `[${stepCount}] ${title}`,
      steps: stepDescriptions.map((desc, i) => ({
        id: i + 1,
        description: desc,
        status: "pending" as StepStatus,
        kind: kinds?.[i] ?? "create",
      })),
      createdAt: new Date().toISOString(),
      baseDir,
    };
  }
```

Update `replan` added steps (line ~86-90) to default `kind: "create"`:

```ts
    const added: PlanStep[] = newSteps.map((desc, i) => ({
      id: kept.length + i + 1,
      description: desc,
      status: "pending" as StepStatus,
      kind: "create",
    }));
```

3b. `src/modules/execution/module.ts` — import `StepKind`:

```ts
import type { Plan, PlanStep, StepKind } from "./planner";
```

3c. In the `plan` tool `parameters.properties`, add:

```ts
						kinds: {
							type: "array",
							items: { type: "string", enum: ["create", "delete"] },
							description:
								'Optional per-step intent, aligned 1:1 with steps. Pass "delete" for steps whose purpose is REMOVING files — the done-gate then requires those files to be GONE (not present). Defaults to "create".',
						},
```

And append to the `plan` tool `description` (after the "Bad:" line):

```
- For steps that REMOVE files, pass kinds: ["delete"] aligned with steps (the done-gate verifies those files are gone instead of demanding they exist).
```

3d. In the `create` action handler (around line ~249), before `PlanCreator.createPlan`:

```ts
					const kindsRaw = Array.isArray(args.kinds)
						? args.kinds.map(String)
						: [];
					if (kindsRaw.length > 0 && kindsRaw.length !== steps.length) {
						return { success: false, output: t("plan.kinds_mismatch") };
					}
					const invalidKinds = kindsRaw.filter(
						(k) => k !== "create" && k !== "delete",
					);
					if (invalidKinds.length > 0) {
						return {
							success: false,
							output: t("plan.kinds_invalid", {
								kinds: invalidKinds.join(", "),
							}),
						};
					}
```

and change the `createPlan` call (line ~258) to:

```ts
						const plan = PlanCreator.createPlan(
							title,
							steps,
							this.baseDir,
							kindsRaw as StepKind[],
						);
```

3e. Replace the deliverable gate in the `update` handler (lines ~366-383):

```ts
					// Deliverable gate: marking a step done must match its declared
					// intent. "create" (default) → named files must exist; "delete"
					// → named files must be GONE. Intent is model-declared (kind),
					// never keyword-inferred (rule #10).
					if (status === "done") {
						if (target.kind === "delete") {
							const leftovers = this.stillExistingDeliverables(target);
							if (leftovers.length > 0) {
								return {
									success: false,
									output: t("plan.deliverables_remain", {
										step: String(stepId),
										files: leftovers.join(", "),
									}),
								};
							}
						} else {
							const missing = this.missingStepDeliverables(target);
							if (missing.length > 0) {
								return {
									success: false,
									output: t("plan.deliverables_missing", {
										step: String(stepId),
										files: missing.join(", "),
									}),
								};
							}
						}
					}
```

3f. Add the `stillExistingDeliverables` helper next to `missingStepDeliverables` (after line ~1047):

```ts
	/**
	 * File tokens named in a step description that still resolve to a real
	 * file. The inverse of missingStepDeliverables — used by the gate for
	 * delete-kind steps ("done" means the files are gone).
	 */
	private stillExistingDeliverables(step: { description: string }): string[] {
		const tokens = extractFileLikeTokens(stripUrls(step.description));
		if (tokens.length === 0) return [];
		return tokens.filter((p) => findExistingFile(this.baseDir, p));
	}
```

3g. `advancePlanIfStepComplete` (lines ~979-1006) — invert auto-advance for delete-kind steps:

```ts
		if (stepPaths.length === 0) return;

		const allExist = stepPaths.every((p) =>
			existsSync(resolve(this.baseDir, p)),
		);
		const allGone = stepPaths.every((p) =>
			!existsSync(resolve(this.baseDir, p)),
		);
		const satisfied =
			step.kind === "delete" ? allGone && !allExist : allExist;
		if (!satisfied) return;
```

The empty-files content check below it must be skipped for delete steps — wrap the whole empty-files block in `if (step.kind !== "delete") { ... }` (lines ~987-1006). (If `allExist` is false for a delete step, `satisfied` is false too, so the block already returns before it; but guard it explicitly for clarity.)

3h. i18n — add to `src/i18n/en.json` and `src/i18n/ru.json`:

`en.json`:
```json
"plan.kinds_mismatch": "kinds array length must match steps",
"plan.kinds_invalid": "Invalid step kind(s): {kinds}. Use \"create\" or \"delete\".",
"plan.deliverables_remain": "Cannot mark step {step} done: the files it names still exist: {files}. This step is kind=delete — delete these files first (or set status=skipped if they should stay)."
```

`ru.json`:
```json
"plan.kinds_mismatch": "Длина kinds должна совпадать с числом шагов",
"plan.kinds_invalid": "Недопустимый kind шага: {kinds}. Используй \"create\" или \"delete\".",
"plan.deliverables_remain": "Нельзя пометить шаг {step} как выполненный: указанные файлы всё ещё существуют: {files}. Шаг имеет kind=delete — сначала удали их (или поставь status=skipped, если они должны остаться)."
```

(Keep the existing `plan.deliverables_missing` unchanged.)

- [x] **Step 4: Run test to verify it passes**

Run: `bun test tests/execution-plan-deliverables.test.ts tests/i18n.test.ts`
Expected: PASS (all 3 new tests + existing deliverable-gate tests + i18n en/ru parity).

- [x] **Step 5: Typecheck + commit**

```bash
bun test tests/execution-plan-deliverables.test.ts tests/i18n.test.ts
tsc --noEmit
git add tests/execution-plan-deliverables.test.ts src/modules/execution/planner.ts src/modules/execution/module.ts src/i18n/en.json src/i18n/ru.json
git commit -m "feat: model-declared plan step kind (create|delete) with deletion-aware deliverable gate"
```

---

## Task 6: Auditor handles delete-kind steps and runs a real typecheck

**Problem:** (a) The final audit would reject a completed deletion task ("missing: AboutPage.js") because it treats every `done` step's named files as required-to-exist. (b) The agent declared "success" while the app was broken — the audit only checked file existence + optional tests, never a typecheck.

**Files:**
- Modify: `src/modules/execution/auditor.ts`
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/execution-auditor.test.ts`

- [x] **Step 1: Write the failing tests**

Add to `tests/execution-auditor.test.ts`:

```ts
	it("passes a done delete-kind step when its files are gone", async () => {
		const plan = PlanCreator.createPlan(
			"test",
			["Remove src/old.js and src/stale.ts"],
			tmpDir,
		);
		plan.steps[0].kind = "delete";
		plan.steps[0].status = "done";
		const result = await auditor.audit(plan);
		expect(result.passed).toBe(true);
		expect(result.missingFiles).toEqual([]);
		expect(result.leftoverFiles).toEqual([]);
	});

	it("fails a done delete-kind step when a named file still exists", async () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src", "old.js"), "x");
		const plan = PlanCreator.createPlan("test", ["Remove src/old.js"], tmpDir);
		plan.steps[0].kind = "delete";
		plan.steps[0].status = "done";
		const result = await auditor.audit(plan);
		expect(result.passed).toBe(false);
		expect(result.leftoverFiles).toEqual(["src/old.js"]);
	});

	it("does not run a typecheck when there is no tsconfig.json", async () => {
		const plan = PlanCreator.createPlan("test", ["Create src/index.ts"], tmpDir);
		plan.steps[0].status = "done";
		writeFileSync(join(tmpDir, "src", "index.ts"), "export const a = 1;\n");
		const result = await auditor.audit(plan);
		expect(result.passed).toBe(true);
		expect(result.typecheckError).toBeNull();
	});
```

Add a small pure-helper describe block:

```ts
import { parseTypecheckErrors } from "../src/modules/execution/auditor";

describe("parseTypecheckErrors", () => {
	it("extracts the first tsc error from output", () => {
		const out =
			"src/a.ts(1,1): error TS6133: 'x' is declared but its value is never read.\nsrc/b.ts(2,2): error TS2322: type mismatch";
		expect(parseTypecheckErrors(out)).toContain("error TS6133");
		expect(parseTypecheckErrors("Build finished successfully")).toBeNull();
	});
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/execution-auditor.test.ts`
Expected: FAIL — delete-kind `done` step still reported `missingFiles`; `leftoverFiles`/`typecheckError` are `undefined` (TS error on `result.leftoverFiles`).

- [x] **Step 3: Implement**

3a. Add fields to `AuditResult` (lines ~95-103):

```ts
export interface AuditResult {
	passed: boolean;
	missingFiles: string[];
	/** Delete-kind steps (done) whose named files still exist. */
	leftoverFiles: string[];
	createdFiles: string[];
	modifiedFiles: string[];
	summary: string;
	massEditWarning: string | null;
	testRun: TestRunCheck | null;
	typecheckError: string | null;
}
```

3b. Add a pure parser + a runner next to `runTests`:

```ts
/** First `error TS…` line in a tsc output, or null when none/inconclusive. */
export function parseTypecheckErrors(output: string): string | null {
	const line = output.split("\n").find((l) => /error TS\d+/.test(l));
	return line ? line.trim().slice(0, 300) : null;
}

async function runTypecheck(baseDir: string): Promise<string | null> {
	const entry = processRegistry.start(
		"npx --no-install tsc --noEmit --skipLibCheck",
		baseDir,
	);
	const exited = await processRegistry.waitForExit(entry.id, 90_000);
	const output = entry.log.join("\n");
	processRegistry.remove(entry.id);
	// Timeout / non-zero exit with no `error TS` lines = inconclusive (missing
	// typescript, wrong working dir) — never block completion on those.
	if (!exited) return null;
	return parseTypecheckErrors(output);
}
```

3c. In `audit()` — split done steps by kind and compute both lists (replace lines ~201-222):

```ts
		const doneCreate = plan.steps.filter(
			(s) => s.status === "done" && s.kind !== "delete",
		);
		const doneDelete = plan.steps.filter(
			(s) => s.status === "done" && s.kind === "delete",
		);
		const createText = doneCreate
			.map((s) => s.description.replace(/\([^)]*\)/g, " "))
			.join(" ");
		const deleteText = doneDelete
			.map((s) => s.description.replace(/\([^)]*\)/g, " "))
			.join(" ");
		const createFiles = extractFileLikeTokens(stripUrls(createText));
		const deleteFiles = extractFileLikeTokens(stripUrls(deleteText));

		const missingFiles: string[] = [];
		const existingFiles: string[] = [];
		const leftoverFiles: string[] = [];

		for (const filePath of createFiles) {
			if (findExistingFile(this.baseDir, filePath)) {
				existingFiles.push(filePath);
			} else {
				missingFiles.push(filePath);
			}
		}
		// A done delete-kind step requires its named files to be GONE.
		for (const filePath of deleteFiles) {
			if (findExistingFile(this.baseDir, filePath)) {
				leftoverFiles.push(filePath);
			}
		}
```

3d. Add the typecheck run after the testRun block (after line ~235):

```ts
		// Real typecheck: the audit must catch "the build is broken" even when
		// every file exists (observed: deleting .js files left the .tsx sources
		// with 11 tsc errors and the agent still declared success). Runs only
		// when a tsconfig.json exists; inconclusive results never block.
		let typecheckError: string | null = null;
		if (existsSync(join(this.baseDir, "tsconfig.json"))) {
			try {
				typecheckError = await runTypecheck(this.baseDir);
			} catch {
				typecheckError = null;
			}
		}
```

3e. Update `passed` and summary (lines ~255-289):

```ts
		const testsFailing = testRun !== null && testRun.failed > 0;
		const typecheckFailing = typecheckError !== null;
		const passed =
			missingFiles.length === 0 &&
			leftoverFiles.length === 0 &&
			!testsFailing &&
			!typecheckFailing;
		const stepsPending = terminalSteps < totalSteps;

		let summary: string;
		if (missingFiles.length > 0) {
			summary = t("exec.audit_fail", {
				done: doneSteps,
				total: totalSteps,
				files: missingFiles.length,
			});
		} else if (leftoverFiles.length > 0) {
			summary = t("exec.audit_leftovers", {
				done: doneSteps,
				total: totalSteps,
				files: leftoverFiles.length,
			});
		} else if (testsFailing) {
			summary = t("exec.audit_fail_tests", {
				done: doneSteps,
				total: totalSteps,
				failed: String(testRun!.failed),
				passed: String(testRun!.passedCount),
				detail: testRun!.detail,
			});
		} else if (typecheckFailing) {
			summary = t("exec.audit_fail_typecheck", {
				done: doneSteps,
				total: totalSteps,
				missing: String(missingFiles.length),
				typeError: typecheckError!,
			});
		} else if (stepsPending) {
			summary = t("exec.audit_pending", {
				done: doneSteps,
				total: totalSteps,
			});
		} else {
			summary = t("exec.audit_pass", {
				done: doneSteps,
				total: totalSteps,
				files: existingFiles.length,
			});
		}

		return {
			passed,
			missingFiles,
			leftoverFiles,
			createdFiles: existingFiles,
			modifiedFiles: [],
			summary,
			massEditWarning,
			testRun,
			typecheckError,
		};
```

3f. i18n — add to both files:

`en.json`:
```json
"exec.audit_leftovers": "[\u2717] Task incomplete: {done}/{total} steps done, {files} files from delete-steps still exist"
```

`ru.json`:
```json
"exec.audit_leftovers": "[\u2717] Задача не выполнена: {done}/{total} шагов, {files} файлов из delete-шагов всё ещё существуют"
```

(`exec.audit_fail_typecheck` already exists in both files — verify and keep.)

- [x] **Step 4: Run test to verify it passes**

Run: `bun test tests/execution-auditor.test.ts tests/i18n.test.ts`
Expected: PASS. (The `does not run a typecheck when there is no tsconfig.json` test confirms no spawn happens in the tmp dir.)

- [x] **Step 5: Typecheck + commit**

```bash
bun test tests/execution-auditor.test.ts tests/i18n.test.ts
tsc --noEmit
git add tests/execution-auditor.test.ts src/modules/execution/auditor.ts src/i18n/en.json src/i18n/ru.json
git commit -m "feat: auditor understands delete-kind steps and runs a real tsc typecheck"
```

---

## Task 7: Hard-stop repeated forbidden Windows commands in `bash`

**Problem:** The model called `grep`/`sed`/`ls`/`find` through the `bash` tool over and over (12 bash calls, all failing); the existing hints fire but a 9B model retries anyway. A session-level hard stop after the second failure of the same forbidden command is evidence-based (actual command failures), not task classification.

**Files:**
- Create: `src/modules/execution/windows-commands.ts`
- Modify: `src/modules/execution/module.ts` (field + `onAfterTool`)
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/windows-commands.test.ts`

- [x] **Step 1: Write the failing tests**

Create `tests/windows-commands.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { forbiddenWindowsCommand } from "../src/modules/execution/windows-commands";

describe("forbiddenWindowsCommand", () => {
	it("detects forbidden unix commands", () => {
		expect(forbiddenWindowsCommand("grep -n foo bar")).toBe("grep");
		expect(forbiddenWindowsCommand("cd src && sed -i s/a/b/ f.ts")).toBe("sed");
		expect(forbiddenWindowsCommand("find bicycle-shop -name '*.js'")).toBe("find");
		expect(forbiddenWindowsCommand("ls src")).toBe("ls");
		expect(forbiddenWindowsCommand("rm src/a.js")).toBe("rm");
	});

	it("allows native windows commands and tools", () => {
		expect(forbiddenWindowsCommand("type foo.txt")).toBeNull();
		expect(forbiddenWindowsCommand("dir /b src")).toBeNull();
		expect(forbiddenWindowsCommand("bun test")).toBeNull();
		expect(forbiddenWindowsCommand("npm run build")).toBeNull();
		expect(forbiddenWindowsCommand("del src\\a.js")).toBeNull();
	});
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/windows-commands.test.ts`
Expected: FAIL — module not found (`Cannot find module .../windows-commands`).

- [x] **Step 3: Implement**

3a. Create `src/modules/execution/windows-commands.ts`:

```ts
/**
 * Unix commands that do not exist (or have incompatible semantics) in Windows
 * cmd.exe. The 9B model keeps reaching for grep/sed/ls/find via the bash tool;
 * each failure returns a hint, but the model retries. The execution module
 * hard-stops a command after its second consecutive failure so the session
 * stops burning tool calls. This is a command allow/deny list (like the
 * security module's command blacklist), NOT task classification (rule #10).
 */
const FORBIDDEN_COMMANDS = new Set([
	"grep",
	"sed",
	"ls",
	"find",
	"rm",
	"touch",
	"which",
	"diff",
	"cp",
	"mv",
]);

function firstWord(command: string): string {
	const segs = command.trim().split(/[\s;|&]+/);
	return (segs[0] || "").replace(/[^\w-]/g, "").toLowerCase();
}

/** The forbidden command name if `command` starts with one (handles `cd x && …`). */
export function forbiddenWindowsCommand(command: string): string | null {
	const m = command.match(/^\s*cd\s+\S+\s*&&\s*(\S+)/);
	if (m) return forbiddenWindowsCommand(m[1]);
	const word = firstWord(command);
	if (word && FORBIDDEN_COMMANDS.has(word)) return word;
	return null;
}
```

3b. `src/modules/execution/module.ts` — add import:

```ts
import { forbiddenWindowsCommand } from "./windows-commands";
```

Add a field near `pendingMessages` (line ~52):

```ts
	private forbiddenBashFailures = new Map<string, number>();
```

In `onAfterTool`, inside the `if (!result.success) { ... }` branch, before `this.stuckDetector.recordToolError(...)` (line ~776), add:

```ts
				if (call.name === "bash") {
					const cmd = String(call.arguments?.command ?? "");
					const forbidden = forbiddenWindowsCommand(cmd);
					if (forbidden) {
						const n =
							(this.forbiddenBashFailures.get(forbidden) || 0) + 1;
						this.forbiddenBashFailures.set(forbidden, n);
						if (n >= 2) {
							this.pendingMessages.push({
								role: "user",
								content: `<system-summary>${t("exec.forbidden_cmd", { cmd: forbidden })}</system-summary>`,
							});
						}
					}
				}
```

3c. i18n — add to both files:

`en.json`:
```json
"exec.forbidden_cmd": "STOP using \"{cmd}\" via the bash tool — it is not a native Windows cmd.exe command and has failed repeatedly this session. Use the dedicated tool instead: grep → the grep tool, ls/dir → list_dir, find → glob, rm → delete_file, sed → edit_file. Do NOT call bash for this purpose again."
```

`ru.json`:
```json
"exec.forbidden_cmd": "ПРЕКРАТИ использовать \"{cmd}\" через bash — это не команда Windows cmd.exe, и она уже неоднократно падала в этой сессии. Используй предназначенный тул: grep → тул grep, ls/dir → list_dir, find → glob, rm → delete_file, sed → edit_file. Больше не вызывай bash для этого."
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test tests/windows-commands.test.ts tests/i18n.test.ts`
Expected: PASS.

- [x] **Step 5: Typecheck + commit**

```bash
bun test tests/windows-commands.test.ts tests/i18n.test.ts
tsc --noEmit
git add tests/windows-commands.test.ts src/modules/execution/windows-commands.ts src/modules/execution/module.ts src/i18n/en.json src/i18n/ru.json
git commit -m "feat: hard-stop repeated forbidden Windows commands in the bash tool"
```

---

## Task 8: Full verification + AGENTS.md changelog

- [x] **Step 1: Run the full suite**

```bash
bun test
tsc --noEmit
```

Expected: all tests pass, no type errors. If a pre-existing test asserted the old `Task:`-only behavior or the old audit summary and now fails, update that test to the new intended behavior and re-run.

- [x] **Step 2: Manual smoke check of the gate behavior**

In a scratch dir (`C:\Users\Alexe\AppData\Local\Temp\opencode\mma-kind-check`), create `a.ts` and run a tiny bun script that drives `ExecutionModule`:

```bash
bun -e "import {ExecutionModule} from './src/modules/execution/module.ts'; const m=new ExecutionModule('.',8); const p=m.getToolDefinitions().find(t=>t.name==='plan'); (async()=>{const c={}; await p.handler(c,{action:'create',title:'T',steps:['Remove a.ts'],kinds:['delete']}); const r=await p.handler(c,{action:'update',step:1,status:'done'}); console.log('blocked:',r.success===false, r.output.slice(0,80)); })();"
```

Expected: `blocked: true Cannot mark step 1 done: the files it names still exist: a.ts`. Then delete `a.ts` and re-run with `rm a.ts` → expect success.

- [x] **Step 3: Update AGENTS.md**

Add a changelog entry at the top of the "Current Version" list (the version list is ordered newest-first; the latest entry is `**37** = ... Version: 0.35.3`). Add:

```markdown
- **38** = agent-loop post-mortem fixes (from ses_mstda6uo — a "delete js duplicates" task that spiraled into a 150-message typecheck whack-a-mole): (1) plan steps gained model-declared `kind: "create"|"delete"` — the deliverable gate now inverts for delete steps (files must be GONE), and the final audit treats a done delete-step's missing files as satisfied (leftover files fail it); (2) compaction keeps a session `mission` — a pasted error/log block (`[User feedback:]`) no longer overwrites `[Task:]`; (3) deleted files leave the compaction `[Files:]` list and are reported as `[Deleted:]`; (4) plan-coverage reads the real user task, not the injected `<system-summary>`; (5) `isFilePathLike` rejects extension-only path tokens (`tsx/.ts`) so the gate can't demand "create tsx/.ts"; (6) final audit runs a real `tsc --noEmit --skipLibCheck` (tsconfig present, 90s cap, inconclusive non-blocking) and surfaces the first error via `exec.audit_fail_typecheck`; (7) repeated forbidden Windows commands (`grep/sed/ls/find/rm/...`) in bash are hard-stopped after 2 failures (`exec.forbidden_cmd`). New i18n: `plan.kinds_mismatch`, `plan.kinds_invalid`, `plan.deliverables_remain`, `exec.audit_leftovers`, `exec.forbidden_cmd` (en+ru). New files: `src/modules/execution/windows-commands.ts`. New tests: `windows-commands.test.ts` (+ cases in `js-identifiers`, `context-manager`, `execution-plan-deliverables`, `execution-auditor`, `execution-plan-coverage`). Version: **0.36.0** (MINOR — new plan-schema field + new audit behavior).
```

- [x] **Step 4: Version bump (release process)**

Per AGENTS.md release process — MINOR (new `kinds` parameter on the `plan` tool + final-audit typecheck behavior):

```bash
npm version minor
```

(Do this only when actually releasing. If releasing later, update `package.json` then. `git tag` is created by `npm version`.)

- [x] **Step 5: Commit AGENTS.md**

```bash
git add AGENTS.md package.json
git commit -m "docs: changelog for agent post-mortem fixes (0.36.0)"
```

---

## Self-Review

- **Spec coverage:** Each diagnosed failure maps to a task — task-drift at compaction → Task 3; stale `[Files:]` → Task 2; deletion-gate fight → Task 5 (+Task 6 audit); `tsx/.ts` false token → Task 1; plan-coverage noise → Task 4; no build verification → Task 6 (typecheck); bash loop → Task 7. `checkPlanAlignment` step-gating and `plan-coverage.extractFilePaths` unification are explicitly out of scope with reasons.
- **Rule #10 (no keyword matching):** No task/step-intent classification by keywords anywhere. Deletion intent is declared by the model (`kinds`), read from tool results (`Deleted <path>`), or from the filesystem (`findExistingFile`). `looksLikeErrorPaste` classifies a user MESSAGE (feedback vs instruction) structurally, not a task.
- **Type consistency:** `kind` on `PlanStep` is optional (`"create"` default) — all existing call sites (`createPlan` without `kinds`, `replan`, `plan-persister` load) keep working. `AuditResult` gains `leftoverFiles` and `typecheckError`; the `module.ts` `runFinalAudit` return object is unchanged (it reads `missingFiles`/`summary`/`passed` only).
- **Placeholder scan:** every task has exact code, exact commands, and expected outcomes.
