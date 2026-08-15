# Complexity Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the complexity debt flagged in `CODE-REVIEW-COMPLEXITY.md` and by the post-mortem branch reviews, enforcing AGENTS.md rules #1 (no file >300 lines) and #2 (small files, single responsibility) on the hotspots the branch touched.

**Architecture:** Mechanical extraction — move self-contained code into focused new files with identical public API, no behavior change. Each split keeps the existing test suite as the safety net (1090 tests). The `agent.ts` `executeSingleAgentLoop` god-method is deliberately EXCLUDED: it has no direct test coverage (only `agent-tool-output.test.ts` exists), so a 735-line split there cannot be verified and is deferred to a follow-up that first builds a loop-level test harness.

**Tech Stack:** Bun + TypeScript, vitest, strict `tsc --noEmit`.

**Rules honored:** #1 no file >300 lines, #2 single responsibility, #7 TDD (behavior preserved — existing tests are the regression guard; add tests only where a new seam is introduced), #4 single source of truth (extract shared `buildRequestBody`, keep token extraction in `js-identifiers.ts`). NO behavior change — this is pure structure.

**Out of scope:** `agent.ts` loop split (no test harness — documented above), security/certification/pipelines modularization (P2, separate effort), plugin lazy-hook dispatch (P1, touches `src/modules/registry.ts` + `plugins/manager.ts`, separate effort).

---

## Task A: Split `auditor.ts` → `audit-runners.ts`

**Problem:** `src/modules/execution/auditor.ts` is 349 lines (>300, crossed in the post-mortem branch). The test-runner / typecheck-runner / token-parsing helpers are self-contained.

**Files:**
- Create: `src/modules/execution/audit-runners.ts`
- Modify: `src/modules/execution/auditor.ts`

- [ ] **Step 1: Read the current auditor.ts and identify what to move**

Read `src/modules/execution/auditor.ts` fully. Move these to `audit-runners.ts` (verbatim, preserving their exports):
- `SKIP_DIRS`, `TEST_EXT_RE`, `TEST_STEP_RE` constants
- `findTestFile`, `hasTestStep`, `extractFailingNames`
- `TestRunCheck` interface
- `runTests`
- `parseTypecheckErrors` (exported — keep exported)
- `runTypecheck`

Keep in `auditor.ts`: `AuditResult`, `findExistingFile` (module.ts imports it from `"./auditor"` — keep the export), `RESOLVE_MAX_DEPTH`, `MASS_EDIT_THRESHOLD`, the `Auditor` class.

- [ ] **Step 2: Move the code**

Create `audit-runners.ts` with the moved items. It needs imports: `processRegistry` from `"../processes"`, `detectTestResults` from `"../../tools/bash"`, `join` from `"path"`, `Dirent`/`readdirSync` from `"fs"`.

In `auditor.ts`:
- Remove the moved code.
- Add `import { runTests, runTypecheck, parseTypecheckErrors, TestRunCheck } from "./audit-runners";`
- **Re-export `parseTypecheckErrors` from auditor.ts** so the existing test import `import { parseTypecheckErrors } from "../src/modules/execution/auditor"` keeps working:
  ```ts
  export { parseTypecheckErrors } from "./audit-runners";
  ```

- [ ] **Step 3: Verify behavior preserved**

Run: `bun test tests/execution-auditor.test.ts tests/execution-plan-deliverables.test.ts tests/execution-scenario-tests.test.ts`
Expected: all pass (the split is pure structure; behavior unchanged).

- [ ] **Step 4: Typecheck + line-count check**

Run: `bunx tsc --noEmit` (exit 0).
Check: `auditor.ts` must be **< 300 lines**, `audit-runners.ts` < 300 lines.

- [ ] **Step 5: Commit**

```bash
git add src/modules/execution/audit-runners.ts src/modules/execution/auditor.ts
git commit -m "refactor: split auditor test/typecheck runners into audit-runners.ts"
```

---

## Task B: Shared `buildRequestBody` in `openai-compat.ts`

**Problem:** Request body construction is duplicated between `doStream` (lines ~98-117) and `doNonStreaming` (lines ~269-288) per CODE-REVIEW-COMPLEXITY.md.

**Files:**
- Modify: `src/llm/openai-compat.ts`
- Test: `tests/openai-compat.test.ts`

- [ ] **Step 1: Read the two request-body construction sites**

Read `src/llm/openai-compat.ts` around `doStream` and `doNonStreaming`. Identify the exact `body` objects built in each.

- [ ] **Step 2: Extract `buildRequestBody`**

Add a module-private helper near the top:

```ts
function buildRequestBody(opts: {
	model: string;
	messages: unknown[];
	tools?: unknown[];
	stream: boolean;
	maxTokens?: number;
	reasoningEffort?: string;
}): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: opts.model,
		messages: opts.messages,
		stream: opts.stream,
	};
	if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;
	if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
	if (opts.reasoningEffort !== undefined) body.reasoning_effort = opts.reasoningEffort;
	return body;
}
```

Use it in BOTH `doStream` and `doNonStreaming`. **Preserve the exact field semantics of the current code** — read the two sites carefully: they may include different fields (e.g. `stream: false` only in non-streaming, `max_tokens`, `reasoning_effort`). The helper must reproduce each site's exact body. If the two bodies differ (e.g. reasoning_effort only in one), pass the union of fields and let each site set what it needs — do NOT unify behavior.

- [ ] **Step 3: Verify**

Run: `bun test tests/openai-compat.test.ts`
Expected: all pass. Then run the full suite `bun test` — expect exit 0.

- [ ] **Step 4: Typecheck + commit**

```bash
bunx tsc --noEmit
git add src/llm/openai-compat.ts
git commit -m "refactor: share buildRequestBody between streaming and non-streaming paths"
```

---

## Task C: Extract `FactExtractor` from `ContextManager`

**Problem:** `src/modules/context/manager.ts` (540 lines) mixes 9 concerns; `extractFacts` is a ~115-line regex matcher. Extract fact extraction into a focused class.

**Files:**
- Create: `src/modules/context/fact-extractor.ts`
- Modify: `src/modules/context/manager.ts`
- Test: `tests/context-manager.test.ts` (unchanged — it must keep passing)

- [ ] **Step 1: Design the extraction**

Read `src/modules/context/manager.ts` fully. The fact state is `fileFacts`, `deletedFacts`, `decisionFacts`, `errorFacts`; the logic is `extractFacts(turns)` and the `[Files:]/[Deleted:]/[Decisions:]/[Errors:]` emission at compact. `ContextManager.MAX_FACTS` (20) and the caps (15/10/5/3) are used.

Create `src/modules/context/fact-extractor.ts`:

```ts
import type { Message } from "./manager";
import { getMessageText } from "../../llm/provider";

/**
 * Regex-based fact extraction from tool/assistant messages. Owns the file /
 * deleted / decision / error fact lists that survive compaction. Extracted
 * from ContextManager so the ~115-line regex logic has one home (rule #2).
 */
export class FactExtractor {
	private fileFacts: string[] = [];
	private deletedFacts: string[] = [];
	private decisionFacts: string[] = [];
	private errorFacts: string[] = [];
	private static readonly MAX_FACTS = 20;

	/** Current fact lists (live files + deleted + decisions + errors). */
	get fileFactsList(): string[] { return this.fileFacts; }
	get deletedFactsList(): string[] { return this.deletedFacts; }

	/** Scan a batch of compacted turns and fold their facts into the lists. */
	extract(turns: Message[]): void { /* moved extractFacts body */ }

	/** The `[Files: ...]` line for a compaction summary (deleted filtered). */
	filesLine(): string | null { /* live files, slice(-15) */ }
	/** The `[Deleted: ...]` line for a compaction summary. */
	deletedLine(): string | null { /* slice(-10) */ }
	/** The `[Decisions: ...]` line for a compaction summary. */
	decisionsLine(): string | null { /* slice(-5) */ }
	/** The `[Errors: ...]` line for a compaction summary. */
	errorsLine(): string | null { /* slice(-3) */ }

	reset(): void { /* clear all four lists */ }
}
```

Move the `extractFacts` body (regex patterns, loop, dedup/last-event-wins logic) into `FactExtractor.extract`. Move the `[Files:]/[Deleted:]/[Decisions:]/[Errors:]` emission from `compact()` into the four `*Line()` methods. Note `extractFacts` currently uses `content.includes("Plan:")` decision extraction and the assistant `decided:`/`decision:` extraction — move those too.

- [ ] **Step 2: Wire into ContextManager**

In `manager.ts`:
- Replace the four fact fields (`fileFacts`, `deletedFacts`, `decisionFacts`, `errorFacts`) with `private facts = new FactExtractor();`
- `compact()`: call `this.facts.extract(oldTurns)`; replace the `[Files:]`/`[Deleted:]`/`[Decisions:]`/`[Errors:]` emission blocks with `this.facts.filesLine()`, etc. (preserve the exact output format — `[Files: a; b]`, `[Deleted: c]`, `[Decisions: d]`, `[Errors: e]`).
- `clear()`: call `this.facts.reset()` instead of resetting the four arrays.
- Remove the now-dead `MAX_FACTS` static and `extractFacts` private method.
- Keep `getQuality()`'s `errorFacts` usage working — check where `this.errorFacts` is read (line ~182 `errorDensity`) and expose it via a getter (`this.facts.errorsList()` or keep a private getter).

- [ ] **Step 3: Verify**

Run: `bun test tests/context-manager.test.ts`
Expected: ALL pass (the output format must be byte-identical). Also `bun test tests/context-manager-multimodal.test.ts`.

- [ ] **Step 4: Typecheck + line-count + commit**

```bash
bunx tsc --noEmit
```
Check `manager.ts` < 300 lines (it should drop ~150). `fact-extractor.ts` < 300 lines.
```bash
git add src/modules/context/fact-extractor.ts src/modules/context/manager.ts
git commit -m "refactor: extract fact extraction from ContextManager into FactExtractor"
```

---

## Task D: Split the `ExecutionModule` god object

**Problem:** `src/modules/execution/module.ts` (1140 lines) is a tool provider + plugin + plan manager + stuck detector wrapper + auditor wrapper + alignment checker. Split the tool definitions and the plugin hooks into focused files; `ExecutionModule` becomes a thin coordinator owning state.

**Files:**
- Create: `src/modules/execution/plan-tool.ts`
- Create: `src/modules/execution/execution-plugin.ts`
- Modify: `src/modules/execution/module.ts`
- Test: all `tests/execution-*.test.ts` (must keep passing unchanged)

- [ ] **Step 1: Map the state and seams**

Read `src/modules/execution/module.ts` fully. State owned by `ExecutionModule`:
`tracker`, `verifier`, `stuckDetector`, `auditor`, `store`, `baseDir`, `lastRecoveryIteration`, `consecutivePlanWarnings`, `lastStepId`, `depsGateHints`, `_auditSkipsRemaining`, `stuckNotified`, `pendingMessages`, `forbiddenBashFailures`.

Public surface used by tests/module-registry: `setPlan`, `restorePlan`, `getTracker`, `getStore`, `getStuckDetector`, `runFinalAudit`, `getSystemPromptBlock`, `getToolDefinitions`, `getPlugin`.

- [ ] **Step 2: Extract the plan/todo/verify tool definitions → `plan-tool.ts`**

Create `plan-tool.ts` exporting a factory:

```ts
import type { ToolDefinition, ToolCall } from "../../tools/types";
import { t } from "../../i18n/index";
import { PlanCreator, type StepKind } from "./planner";
import { PlanStore } from "./plan-store";
import { StepVerifier } from "./verifier";

export interface PlanToolDeps {
	store: PlanStore;
	verifier: StepVerifier;
	trackerRef: { current: import("./planner").PlanTracker | null };
	preserveActive(): void;
	setPlan(plan: import("./planner").Plan): void;
	missingStepDeliverables(step: { description: string }): string[];
	stillExistingDeliverables(step: { description: string }): string[];
	parseKinds(args: Record<string, unknown>, steps: string[]): { kinds: StepKind[] | null; error: string | null };
	getTaskText(ctx: any): string;
}

export function createPlanToolDefinitions(deps: PlanToolDeps): ToolDefinition[] {
	// plan / todo / verify definitions, handlers moved verbatim from
	// ExecutionModule.getToolDefinitions(), replacing `this.X` with `deps.X`.
}
```

Move the `plan` (create/update/show/abort/list/switch/re-plan) + `todo` + `verify` handlers from `module.ts` verbatim, translating `this.` references:
- `this.store` → `deps.store`
- `this.verifier` → `deps.verifier`
- `this.tracker` → `deps.trackerRef.current`
- `this.preserveActive()` → `deps.preserveActive()`
- `this.setPlan(...)` → `deps.setPlan(...)`
- `this.missingStepDeliverables(...)` → `deps.missingStepDeliverables(...)`
- `this.stillExistingDeliverables(...)` → `deps.stillExistingDeliverables(...)`
- `this.parseKinds(...)` → `deps.parseKinds(...)`
- `this.getTaskText(_ctx)` → `deps.getTaskText(_ctx)`
- The handlers use `_ctx.sessionLog?.plan(...)` — keep (ToolContext).
- The `plan` handler's `output`/`display`/`t(...)` calls — keep.

- [ ] **Step 3: Extract the plugin hooks → `execution-plugin.ts`**

Create `execution-plugin.ts` exporting a factory:

```ts
import type { AgentPlugin } from "../types";
import { t } from "../../i18n/index";
import { StuckDetector } from "./stuck-detector";
import { PlanStore } from "./plan-store";

export interface ExecutionPluginDeps {
	store: PlanStore;
	stuckDetector: StuckDetector;
	baseDir: string;
	trackerRef: { current: import("./planner").PlanTracker | null };
	pendingMessages: Array<{ role: "user"; content: string }>;
	forbiddenBashFailures: Map<string, number>;
	state: {
		lastRecoveryIteration: number;
		consecutivePlanWarnings: number;
		lastStepId: number;
		stuckNotified: boolean;
		depsGateHints: Map<number, number>;
	};
	checkPlanAlignment(call: any): string | null;
	advancePlanIfStepComplete(
		contextManager?: any,
		sessionLog?: { plan(event: string, detail: string, iteration?: number): void },
	): void;
	runFinalAudit(): ReturnType<ExecutionModule["runFinalAudit"]>; // or a lighter shape
}

export function createExecutionPlugin(deps: ExecutionPluginDeps): AgentPlugin {
	// onBeforeThink / onBeforeTool / onToolCall / onAfterTool, moved verbatim,
	// with `this.X` → `deps.X`. STUCK_RECOVERY_COOLDOWN and
	// MAX_PLAN_WARNINGS_BEFORE_BLOCK constants move here.
}
```

Move `getPlugin()` from `module.ts` verbatim, translating `this.`:
- `this.tracker` → `deps.trackerRef.current`
- `this.stuckDetector` → `deps.stuckDetector`
- `this.pendingMessages` → `deps.pendingMessages`
- `this.forbiddenBashFailures` → `deps.forbiddenBashFailures`
- `this.consecutivePlanWarnings` / `this.lastStepId` / `this.stuckNotified` / `this.lastRecoveryIteration` / `this.depsGateHints` → `deps.state.*` (the module passes an object it owns, so mutations persist)
- `this.checkPlanAlignment(call)` → `deps.checkPlanAlignment(call)`
- `this.advancePlanIfStepComplete(...)` → `deps.advancePlanIfStepComplete(...)`
- `this.baseDir` → `deps.baseDir`
- `this.store` → `deps.store`
- `this.runFinalAudit` is NOT used by the plugin (verify); if it is, add to deps.
- The `onBeforeThink` "no plan" messages use `ctx.contextManager` — keep as-is.

Keep in module.ts: `checkPlanAlignment`, `advancePlanIfStepComplete`, `missingStepDeliverables`, `stillExistingDeliverables`, `parseKinds`, `getTaskText`, `preserveActive`, `setPlan`, `restorePlan`, `runFinalAudit`, `getSystemPromptBlock`.

- [ ] **Step 4: Rewire `ExecutionModule`**

`getToolDefinitions()`:
```ts
	getToolDefinitions(): ToolDefinition[] {
		return createPlanToolDefinitions({
			store: this.store,
			verifier: this.verifier,
			trackerRef: this.trackerRef,
			preserveActive: () => this.preserveActive(),
			setPlan: (p) => this.setPlan(p),
			missingStepDeliverables: (s) => this.missingStepDeliverables(s),
			stillExistingDeliverables: (s) => this.stillExistingDeliverables(s),
			parseKinds: (a, st) => this.parseKinds(a, st),
			getTaskText: (c) => this.getTaskText(c),
		});
	}
```

Add `private trackerRef = { get current() { return this.tracker; }, set current(v) { this.tracker = v; } };` OR simpler — pass a getter: `trackerRef: { get current() { return this.tracker; } }`. The plugin/tool factories only READ `current`, so a getter suffices.

`getPlugin()`:
```ts
	getPlugin(): AgentPlugin {
		return createExecutionPlugin({
			store: this.store,
			stuckDetector: this.stuckDetector,
			baseDir: this.baseDir,
			trackerRef: { get current() { return this.tracker; } },
			pendingMessages: this.pendingMessages,
			forbiddenBashFailures: this.forbiddenBashFailures,
			state: {
				lastRecoveryIteration: this.lastRecoveryIteration,
				consecutivePlanWarnings: this.consecutivePlanWarnings,
				lastStepId: this.lastStepId,
				stuckNotified: this.stuckNotified,
				depsGateHints: this.depsGateHints,
			},
			checkPlanAlignment: (call) => this.checkPlanAlignment(call),
			advancePlanIfStepComplete: (cm, sl) => this.advancePlanIfStepComplete(cm, sl),
		});
	}
```

**CRITICAL — shared mutable state:** `pendingMessages`, `forbiddenBashFailures`, `depsGateHints`, and `state.*` are mutated by the plugin AND (for `pendingMessages`) by `onBeforeThink`'s flush. The module must own them and the plugin must mutate the SAME objects. Passing the arrays/maps/object by reference achieves that (the plugin pushes to `deps.pendingMessages`, `deps.forbiddenBashFailures.set(...)`, `deps.state.lastRecoveryIteration = ...`). For `state.*` primitives, the module writes back after `getPlugin()`? NO — the plugin mutates `deps.state.lastRecoveryIteration` directly (same object), so the module's `this.lastRecoveryIteration` must be the same. Cleanest: module owns the `state` object and reads `this.state.lastRecoveryIteration` instead of `this.lastRecoveryIteration` in its own methods. **Verify every mutation site and make sure module and plugin share one object.** Alternatively the module keeps its fields and passes getters+setters — but that's verbose. Choose the shared-object approach and update module.ts's own reads (`runFinalAudit`, `getSystemPromptBlock`, `restorePlan` set `_auditSkipsRemaining`) accordingly.

- [ ] **Step 5: Verify**

Run: `bun test tests/execution` (expect all execution tests pass — they exercise getToolDefinitions/getPlugin via the public API).
Also `bun test` full suite — exit 0.
Also check `src/modules/execution/index.ts` exports still work (it re-exports types + ExecutionModule).

- [ ] **Step 6: Typecheck + line-count + commit**

```bash
bunx tsc --noEmit
```
Check: `module.ts` must drop to **< 400 lines** (was 1140). `plan-tool.ts` and `execution-plugin.ts` < 300 lines each. If module.ts stays >300, that's acceptable IF the extraction removed the two biggest chunks (tool defs ~475 lines + plugin ~295 lines) — record the final count in the report.
```bash
git add src/modules/execution/plan-tool.ts src/modules/execution/execution-plugin.ts src/modules/execution/module.ts
git commit -m "refactor: split ExecutionModule into plan-tool and execution-plugin factories"
```

---

## Self-Review

- **Spec coverage:** All four CODE-REVIEW-COMPLEXITY.md P0/P1 items that touch files the post-mortem branch grew (auditor, module, manager) plus the P2 openai-compat duplication. `agent.ts` loop split excluded with explicit justification (no test harness).
- **Behavior preservation:** Every task is a pure structural extraction — the existing 1090-test suite is the regression guard; no behavior-changing edits.
- **Rule #1:** target files must end < 300 lines (except module.ts which is allowed to shrink to < 400 if the two extracted chunks are the bulk — record actual).
- **Rule #4:** token extraction stays in `js-identifiers.ts`; request body now shared.
- **Deferred (documented in AGENTS.md changelog as follow-ups):** `agent.ts` phase split (needs loop harness first), plugin lazy-hook dispatch, security/certification/pipelines modularization.
