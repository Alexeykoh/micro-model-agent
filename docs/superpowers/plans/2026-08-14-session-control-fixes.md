# Session Control & Reliability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 4 harness defects found in post-mortem analysis of session `ses_mssx0k11_2ajcag` — dead LSP for nested projects, a plan deliverable gate + auditor that loop forever when a step references an existing file, Windows bash hints/block defeated by the `cat→type` translation, and budget-based tool-result truncation that blinds the model on `read_file`.

**Architecture:** Targeted fixes in 4 layers: (1) LSP — resolve the workspace root from the *edited file's project* using per-language markers declared in the LSP config; (2) execution — the auditor requires files only from `done` steps and honors `skipped` as a terminal step status; (3) bash — key the Windows hint/hard-block on the *original* command word, not the translated one; (4) agent loop — never budget-truncate tools that declare `boundedOutput` on their definition.

**Design constraints honored (AGENTS.md):**
- **No heuristics / no language fitting:** no keyword matching (rule #10), no English-plural filename rule, no hardcoded tool-name list in the core loop. Every "special case" is expressed as *declarative data on the thing it describes* (tool definitions, LSP server config).
- **TDD** (rule #7): failing test → minimal implementation → passing test → commit.
- **i18n** (rule #8): no new user-facing strings; reuses existing `tool.truncated`, hint, and plan keys.
- **PATCH version bump** (bug fixes only).

**Tech Stack:** Bun, TypeScript, vitest (`bun test`), `tsc --noEmit`.

---

## Root Causes (from session post-mortem)

| # | Symptom in session | Root cause | Fix |
|---|--------------------|-----------|-----|
| 1 | `[LSP check failed]: Could not find a valid TypeScript installation` on every write/edit | `LspModule` passes `baseDir` (`E:\projects\mma_tests`) as the LSP workspace root; the edited file lives in a nested project (`bicycle-shop/`) whose `node_modules/typescript` the tsserver never sees | Resolve the nearest project root from the file's path using the markers the server config declares for its language; use it as `cwd` + `rootUri` |
| 2 | `plan update step=1 done` refused 4× («files it names do not exist yet: type.ts»); final audit `1 files missing` forever | Step 1 ("Проверить тип данных ... в type.ts") is a *read/verify* step referencing an existing file. The deliverable gate treats the prose token as a required deliverable and blocks `done`; the auditor then scans the *skipped* step's text and reports `type.ts` missing forever | Gate stays strict (documented escape hatch is `skipped`); auditor scans only `done` steps for missing files and treats `skipped` as a terminal complete state |
| 3 | Model ran `cat`/`grep`/`ls` 4–8× with no hint, no hard-block | `adaptCommandForWindows` translates `cat`→`type`, then the win32 hint/block checks the *translated* first word (`type`, not in `UNIX_TO_WIN_HINTS`) | Key the hint/block on the original command's first word |
| 4 | Model re-read the same file 8+× («Файл обрезан»); compaction every iteration | `truncateToolOutput` cuts `read_file` output to ~2.2K chars near-full budget, so the model can't see the full file and loops | Tools that bound their own output declare `boundedOutput: true` on their definition; the agent never budget-truncates them |

---

## File Structure

| File | Change |
|------|--------|
| `src/modules/lsp/project-root.ts` | **New** — `findProjectRoot(filePath, baseDir, markers)` walks up from the file to the nearest dir containing any marker, bounded by `baseDir` |
| `src/modules/lsp/types.ts` | `LspServerConfig` gains `workspaceMarkers?: string[]` |
| `src/modules/lsp/config.ts` | Per-language `workspaceMarkers` in `DEFAULT_LSP_CONFIG.servers` |
| `src/modules/lsp/client.ts` | `checkFile(…, projectRoot)` — spawn `cwd` + `rootUri` use `projectRoot` (fallback `baseDir`) |
| `src/modules/lsp/module.ts` | Compute `projectRoot` from `fullPath` + server's `workspaceMarkers` and pass it to `checkFile` |
| `src/modules/execution/auditor.ts` | `audit()` — extract file tokens only from `done` steps; count `done + skipped` as complete |
| `src/modules/execution/module.ts` | `missingStepDeliverables` — unchanged (gate stays strict; `skipped` is the documented escape hatch) |
| `src/tools/bash.ts` | Win32 hint/hard-block: use `originalCommand`'s first word for `UNIX_TO_WIN_HINTS` + `FAILING_FIRST_WORDS` |
| `src/tools/types.ts` | `ToolDefinition` gains `boundedOutput?: boolean` |
| `src/tools/read-file.ts`, `list-dir.ts`, `file-info.ts`, `process-log.ts` | Declare `boundedOutput: true` |
| `src/tools/registry.ts` | `getAllForLLM` includes `boundedOutput` in its `Pick` |
| `src/core/agent.ts` | `toolOutputCharLimit(remaining, history, bounded)` + read the flag from the tool definitions; `truncateToolOutput` passes it |
| Tests | New `tests/lsp-project-root.test.ts`, `tests/agent-tool-output.test.ts`; extend `tests/lsp-module.test.ts`, `tests/execution-plan-deliverables.test.ts`, `tests/execution-auditor.test.ts`, `tests/bash.test.ts` |
| `package.json` | PATCH bump `0.35.2 → 0.35.3` |
| `CHANGELOG.md` | Add `[0.35.3]` section |
| `AGENTS.md` | Update Current Version section |

---

### Task 1: LSP — resolve workspace root from the edited file's project (config-declared markers)

**Files:**
- Create: `src/modules/lsp/project-root.ts`
- Modify: `src/modules/lsp/types.ts`, `src/modules/lsp/config.ts`, `src/modules/lsp/client.ts`, `src/modules/lsp/module.ts`
- Test: `tests/lsp-project-root.test.ts` (new), `tests/lsp-module.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/lsp-project-root.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { findProjectRoot } from "../src/modules/lsp/project-root";

describe("findProjectRoot", () => {
	let tmp = "";
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "lsp-root-"));
	});
	afterEach(() => {
		if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
	});

	it("returns baseDir when no configured marker exists anywhere", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		const file = join(tmp, "src", "a.ts");
		writeFileSync(file, "export const a = 1;\n");
		expect(findProjectRoot(file, tmp, ["package.json", "tsconfig.json"])).toBe(
			tmp,
		);
	});

	it("finds the nearest ancestor containing a configured marker", () => {
		mkdirSync(join(tmp, "bicycle-shop", "src"), { recursive: true });
		writeFileSync(join(tmp, "bicycle-shop", "tsconfig.json"), "{}");
		const file = join(tmp, "bicycle-shop", "src", "a.ts");
		writeFileSync(file, "export const a = 1;\n");
		expect(findProjectRoot(file, tmp, ["package.json", "tsconfig.json"])).toBe(
			join(tmp, "bicycle-shop"),
		);
	});

	it("uses the language's own markers (e.g. go.mod for Go), not JS markers", () => {
		mkdirSync(join(tmp, "svc", "cmd"), { recursive: true });
		writeFileSync(join(tmp, "svc", "go.mod"), "module svc\n");
		const file = join(tmp, "svc", "cmd", "main.go");
		writeFileSync(file, "package main\n");
		// package.json absent — the walk must rely on the passed markers.
		expect(findProjectRoot(file, tmp, ["go.mod"])).toBe(join(tmp, "svc"));
		expect(findProjectRoot(file, tmp, ["package.json"])).toBe(tmp);
	});

	it("does not climb above baseDir", () => {
		mkdirSync(join(tmp, "proj", "src"), { recursive: true });
		writeFileSync(join(tmp, "package.json"), "{}");
		const file = join(tmp, "proj", "src", "a.ts");
		writeFileSync(file, "export const a = 1;\n");
		expect(findProjectRoot(file, join(tmp, "proj"), ["package.json"])).toBe(
			join(tmp, "proj"),
		);
	});
});
```

Append to `tests/lsp-module.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/lsp-project-root.test.ts tests/lsp-module.test.ts`
Expected: FAIL — `findProjectRoot` not exported / module doesn't pass a 4th arg.

- [ ] **Step 3: Add `workspaceMarkers` to the LSP server config**

`src/modules/lsp/types.ts` — add the field:

```typescript
export interface LspServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  timeout?: number
  autoInstall?: boolean
  /** Project-root markers for this language (e.g. ["package.json","tsconfig.json"]). */
  workspaceMarkers?: string[]
}
```

`src/modules/lsp/config.ts` — declare markers per language in `DEFAULT_LSP_CONFIG.servers`:

```typescript
servers: {
  typescript: {
    command: 'npx',
    args: ['typescript-language-server', '--stdio'],
    timeout: 20000,
    autoInstall: true,
    workspaceMarkers: ['package.json', 'tsconfig.json'],
  },
  javascript: {
    command: 'npx',
    args: ['typescript-language-server', '--stdio'],
    timeout: 15000,
    autoInstall: true,
    workspaceMarkers: ['package.json', 'tsconfig.json'],
  },
  python: {
    command: 'npx',
    args: ['pyright', '--stdio'],
    timeout: 15000,
    autoInstall: true,
    workspaceMarkers: ['pyproject.toml', 'setup.py', 'requirements.txt'],
  },
  rust: {
    command: 'rust-analyzer',
    timeout: 15000,
    autoInstall: false,
    workspaceMarkers: ['Cargo.toml'],
  },
  go: {
    command: 'gopls',
    timeout: 15000,
    autoInstall: false,
    workspaceMarkers: ['go.mod'],
  },
  json: {
    command: 'npx',
    args: ['vscode-json-languageserver', '--stdio'],
    timeout: 10000,
    autoInstall: true,
    workspaceMarkers: ['package.json'],
  },
  html: {
    command: 'npx',
    args: ['vscode-html-languageserver', '--stdio'],
    timeout: 10000,
    autoInstall: true,
    workspaceMarkers: ['package.json'],
  },
  css: {
    command: 'npx',
    args: ['vscode-css-languageserver', '--stdio'],
    timeout: 10000,
    autoInstall: true,
    workspaceMarkers: ['package.json'],
  },
},
```

- [ ] **Step 4: Create `src/modules/lsp/project-root.ts`**

```typescript
import { existsSync } from "fs";
import { dirname, join } from "path";

/**
 * Resolve the LSP workspace root for an edited file.
 *
 * The workspace root must be the nearest project of the *edited file*, not the
 * agent baseDir — tsserver resolves `typescript` relative to the workspace
 * root, so for a file in `bicycle-shop/src/x.ts` under baseDir `mma_tests` the
 * root must be `bicycle-shop` (observed: "Could not find a valid TypeScript
 * installation" on every write/edit because baseDir had no node_modules).
 *
 * Which files mark a project root is language-specific and is declared in the
 * LSP server config (`LspServerConfig.workspaceMarkers`) — this function takes
 * the markers as a parameter and performs no language detection itself.
 */
export function findProjectRoot(
	filePath: string,
	baseDir: string,
	markers: string[],
): string {
	if (!markers || markers.length === 0) return baseDir;
	let dir = dirname(filePath);
	const root = baseDir.replace(/[\\/]+$/, "");
	while (true) {
		if (markers.some((m) => existsSync(join(dir, m)))) {
			return dir;
		}
		if (dir === root) return dir;
		const parent = dirname(dir);
		if (parent === dir) return root;
		dir = parent;
	}
}
```

- [ ] **Step 5: Wire the project root into `client.ts`**

Modify `src/modules/lsp/client.ts`:

```typescript
import { findProjectRoot } from "./project-root";
```

Change the `checkFile` signature and the initialize/cwd sites:

```typescript
async checkFile(
	filePath: string,
	baseDir: string,
	config: LspServerConfig,
	projectRoot: string = baseDir,
): Promise<LspDiagnostic[]> {
	const timeout = config.timeout ?? DEFAULT_TIMEOUT;

	try {
		await this.startServer(config, projectRoot);

		const rootUri = this.pathToUri(projectRoot);
		// ... rest unchanged
	}
```

In `startServer`, spawn with `cwd` set to `projectRoot` instead of `baseDir`:

```typescript
private async startServer(
	config: LspServerConfig,
	projectRoot: string,
): Promise<void> {
	// ... where statement unchanged ...
	const spawnOpts: SpawnOptions = {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...config.env },
		cwd: projectRoot,
	};
	// ... rest unchanged ...
}
```

- [ ] **Step 6: Wire the project root into `module.ts`**

Modify `src/modules/lsp/module.ts` (compute root from the *full* path + the server's markers):

```typescript
import { resolve } from "path";
import { findProjectRoot } from "./project-root";
// ...existing imports...

const fullPath = resolve(_ctx.baseDir, filePath)
if (!existsSync(fullPath)) return

const serverConfig = getServerForFile(fullPath, self.config)
if (!serverConfig) return

const projectRoot = findProjectRoot(
	fullPath,
	_ctx.baseDir,
	serverConfig.workspaceMarkers ?? [],
)
try {
	const diagnostics = await self.client.checkFile(fullPath, _ctx.baseDir, serverConfig, projectRoot)
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test tests/lsp-project-root.test.ts tests/lsp-module.test.ts`
Expected: PASS (both new and existing tests).

- [ ] **Step 8: Typecheck + commit**

```bash
tsc --noEmit
git add src/modules/lsp/project-root.ts src/modules/lsp/types.ts src/modules/lsp/config.ts src/modules/lsp/client.ts src/modules/lsp/module.ts tests/lsp-project-root.test.ts tests/lsp-module.test.ts
git commit -m "fix: LSP workspace root resolved from the file's project via config-declared per-language markers"
```

---

### Task 2: Auditor — scan `done` steps only, honor `skipped` as terminal

**Files:**
- Modify: `src/modules/execution/auditor.ts:196-276`
- Test: `tests/execution-auditor.test.ts`, `tests/execution-plan-deliverables.test.ts`

**Rationale (no heuristic):** the deliverable gate's purpose is to catch "mark done while the named file is missing/deleted" (ses_msstxxff regression). The gate must stay strict. A step that *references* an existing file in prose (step 1 in the session: "Проверить ... в type.ts") has a documented escape hatch — `status=skipped` (the gate error message already says so). The two actual bugs are in the *auditor*: it scans skipped steps' text (producing a phantom `type.ts`), and it treats `skipped` as not-done (so a plan with a legitimately skipped step can never pass). Both are fixed by status-aware logic, not by filename matching.

- [ ] **Step 1: Write the failing tests**

Append to `tests/execution-auditor.test.ts`:

```typescript
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
```

Append to `tests/execution-plan-deliverables.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/execution-auditor.test.ts tests/execution-plan-deliverables.test.ts`
Expected: FAIL — auditor scans all steps and treats skipped as incomplete.

- [ ] **Step 3: Restrict the auditor's file scan to `done` steps**

Modify `src/modules/execution/auditor.ts:196-199`:

```typescript
async audit(plan: Plan): Promise<AuditResult> {
	// Only steps the model claims completed may require their named files to
	// exist. Skipped/pending steps must never contribute "missing files"
	// (observed: a skipped step's prose mention of "type.ts" kept the audit
	// gate rejecting a finished task with "1 files missing" forever).
	const allStepText = plan.steps
		.filter((s) => s.status === "done")
		.map((s) => s.description.replace(/\([^)]*\)/g, " "))
		.join(" ");
```

- [ ] **Step 4: Treat `skipped` as a terminal complete state**

Modify the completion check (`auditor.ts:232` and `:248`):

```typescript
// done + skipped are both deliberate terminal states: `done` claims the work,
// `skipped` documents a decision that the step is not needed (the gate's
// escape hatch). Neither is a lie the audit must catch.
const terminalSteps = plan.steps.filter(
	(s) => s.status === "done" || s.status === "skipped",
).length;
const totalSteps = plan.steps.length;
// ...
const stepsPending = terminalSteps < totalSteps;
```

Where `doneSteps` was used elsewhere (the audit summary count), keep reporting `done` steps as done; only the *pending* determination uses `terminalSteps`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/execution-auditor.test.ts tests/execution-plan-deliverables.test.ts`
Expected: PASS — existing strict-gate tests still green, new status-aware tests pass.

- [ ] **Step 6: Typecheck + commit**

```bash
tsc --noEmit
git add src/modules/execution/auditor.ts tests/execution-auditor.test.ts tests/execution-plan-deliverables.test.ts
git commit -m "fix: auditor scans done steps only and honors skipped as terminal (phantom-file loop)"
```

---

### Task 3: Bash — key the Windows hint/hard-block on the original command word

**Files:**
- Modify: `src/tools/bash.ts:481-501`
- Test: `tests/bash.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/bash.test.ts`:

```typescript
it("hints on the ORIGINAL first word even when it was translated (cat→type)", async () => {
	const { platform } = await import("os");
	if (platform() !== "win32") return; // cat works on POSIX

	resetBashFailureTracking();
	const ctx = makeCtx();
	// `cat` is translated to `type` by adaptCommandForWindows; the hint/block
	// must still key on `cat` (ses_mssx0k11: model ran cat 4× with no hint).
	const r = await bashTool.handler(ctx, { command: "cat does-not-exist.txt" });
	expect(r.output).toContain("cat");
	expect(r.output).toContain("read_file");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bash.test.ts`
Expected: FAIL — hint keys on `type` (translated), not `cat`.

- [ ] **Step 3: Implement the fix in `bash.ts`**

The translated command is `command`; we still execute it, but the hint/block bookkeeping must use the original word. Modify the win32 block (lines ~481-501):

```typescript
if (platform() === "win32") {
	const originalFirstWord = originalCommand
		.trim()
		.split(/\s+/)[0]
		?.split(/[\\/]/)
		.pop();
	if (originalFirstWord && originalFirstWord in UNIX_TO_WIN_HINTS) {
		if (code === 0) {
			FAILING_FIRST_WORDS.delete(originalFirstWord);
		} else {
			const failures =
				(FAILING_FIRST_WORDS.get(originalFirstWord) || 0) + 1;
			FAILING_FIRST_WORDS.set(originalFirstWord, failures);
			if (failures >= HARD_BLOCK_THRESHOLD) {
				output = `STOP using "${originalFirstWord}" — it does not work in this cmd.exe shell and has failed ${failures} times in a row. ${UNIX_TO_WIN_HINTS[originalFirstWord]}`;
			} else {
				output = `${output}\n\nHint: "${originalFirstWord}" may not work on Windows. ${UNIX_TO_WIN_HINTS[originalFirstWord]}`;
			}
		}
	}
}
```

The existing win32-only hard-block test at `tests/bash.test.ts:66` calls `bashTool` with `head`, which is not translated, so the original word equals the translated word — it keeps passing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/bash.test.ts`
Expected: PASS — new test + existing win32 hard-block test.

- [ ] **Step 5: Typecheck + commit**

```bash
tsc --noEmit
git add src/tools/bash.ts tests/bash.test.ts
git commit -m "fix: bash Windows hint/hard-block keys on the original command word (cat→type translation defeated it)"
```

---

### Task 4: Agent loop — never budget-truncate tools that declare `boundedOutput`

**Files:**
- Modify: `src/tools/types.ts`, `src/tools/read-file.ts`, `src/tools/list-dir.ts`, `src/tools/file-info.ts`, `src/tools/process-log.ts`, `src/tools/registry.ts`, `src/core/agent.ts:174-198, 358-369, 665`
- Test: `tests/agent-tool-output.test.ts` (new)

**Rationale (no hardcoded name list):** the decision "this tool bounds its own output" is a property of the tool, so it belongs on the `ToolDefinition` — exactly like the existing `interactive` and `timeoutMs` flags. The agent reads the flag; it does not maintain a magic set of tool names.

- [ ] **Step 1: Write the failing test**

`tests/agent-tool-output.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { toolOutputCharLimit } from "../src/core/agent";

describe("toolOutputCharLimit", () => {
	it("never truncates a tool that declares boundedOutput regardless of remaining budget", () => {
		// Near-full context (remaining 2245 of 24577): a bounded read tool must
		// NOT be cut to ~2K chars — the model then believes files are truncated
		// and loops re-reading them (ses_mssx0k11).
		expect(toolOutputCharLimit(2245, 24577, true)).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("still truncates unbounded tools by budget", () => {
		const limit = toolOutputCharLimit(2245, 24577, false);
		expect(limit).toBeLessThan(24577 * 0.3 * 2);
		expect(limit).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent-tool-output.test.ts`
Expected: FAIL — `toolOutputCharLimit` not exported (module error).

- [ ] **Step 3: Add the `boundedOutput` flag to `ToolDefinition`**

`src/tools/types.ts`:

```typescript
	/**
	 * The tool bounds its own output size (line limits, entry caps, tail caps).
	 * Budget-based truncation in the agent loop must never apply to such tools —
	 * near-full context was cutting read_file results to ~2K chars, making the
	 * model believe files were truncated and re-read them forever.
	 */
	boundedOutput?: boolean;
```

Declare it on the four self-bounded tools:

- `src/tools/read-file.ts` (output bounded by `limit` lines, default 300)
- `src/tools/list-dir.ts` (bounded by `MAX_PREVIEW_LINES`)
- `src/tools/file-info.ts` (metadata JSON, small)
- `src/tools/process-log.ts` (bounded by `tail`, max 300)

Each gets `boundedOutput: true` in its definition object, e.g.:

```typescript
export const readFileTool: ToolDefinition = {
	name: "read_file",
	description: `Read a file from the filesystem. Reads up to ${DEFAULT_LIMIT} lines at a time by default; use offset to page through large files.`,
	tags: ["file", "code"],
	boundedOutput: true,
	parameters: { /* ...unchanged... */ },
	handler: async (ctx, args) => { /* ...unchanged... */ },
};
```

- [ ] **Step 4: Include the flag in `registry.ts`**

`src/tools/registry.ts:36-43`:

```typescript
getAllForLLM(tags?: string[]): Array<
	Pick<ToolDefinition, "name" | "description" | "parameters" | "boundedOutput">
> {
	const tools = tags ? this.getByTags(tags) : this.getAll()
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.parameters,
		boundedOutput: t.boundedOutput,
	}))
}
```

- [ ] **Step 5: Use the flag in `agent.ts`**

Add the exported pure function and change the private method (lines ~174-198):

```typescript
/** Max chars a tool result may occupy, given remaining budget and boundedness. */
export function toolOutputCharLimit(
	remainingBudget: number,
	historyBudget: number,
	bounded: boolean,
): number {
	if (bounded) return Number.MAX_SAFE_INTEGER;
	const maxCharsByRatio = Math.floor(
		historyBudget * TOOL_RESULT_MAX_TOKENS_RATIO * 2,
	);
	return Math.min(
		remainingBudget,
		maxCharsByRatio,
		TOOL_RESULT_ABSOLUTE_MAX_CHARS,
	);
}
```

Rewrite the private method to delegate:

```typescript
private truncateToolOutput(
	output: string,
	budget: { history: number },
	currentTokens: number,
	bounded: boolean,
): string {
	const remainingBudget = Math.max(0, budget.history - currentTokens);
	const maxChars = toolOutputCharLimit(
		remainingBudget,
		budget.history,
		bounded,
	);
	if (output.length <= maxChars) return output;
	const truncated = output.slice(0, maxChars);
	const removedChars = output.length - maxChars;
	return (
		truncated +
		`\n\n${t("tool.truncated", { tokens: Math.ceil(removedChars / 2) })}`
	);
}
```

Build the bounded-name set once from the tool definitions already fetched for the budget (lines ~358-369):

```typescript
const allToolsForBudget = toolExecutor.getToolDefinitions(
	this.deps.toolTags,
);
const boundedToolNames = new Set(
	allToolsForBudget
		.filter((t) => t.boundedOutput)
		.map((t) => t.name),
);
const toolTokenEstimate = allToolsForBudget.reduce(
	(sum, t) =>
		sum +
		Math.ceil(
			(t.description.length + JSON.stringify(t.parameters).length) / 4,
		),
	0,
);
contextManager.setToolTokens(toolTokenEstimate);
```

At the call site (line ~665), pass whether the tool is bounded:

```typescript
const truncatedOutput = this.truncateToolOutput(
	result.output,
	budget,
	currentTokens,
	boundedToolNames.has(call.name),
);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/agent-tool-output.test.ts`
Expected: PASS. Also run the full `bun test` suite to confirm no regression in truncation-dependent tests.

- [ ] **Step 7: Typecheck + commit**

```bash
tsc --noEmit
git add src/tools/types.ts src/tools/read-file.ts src/tools/list-dir.ts src/tools/file-info.ts src/tools/process-log.ts src/tools/registry.ts src/core/agent.ts tests/agent-tool-output.test.ts
git commit -m "fix: never budget-truncate tools that declare boundedOutput (read_file loop at near-full context)"
```

---

### Task 5: Version bump, CHANGELOG, AGENTS.md

**Files:**
- Modify: `package.json`, `CHANGELOG.md`, `AGENTS.md`

- [ ] **Step 1: Bump patch version**

`package.json`: `"version": "0.35.2"` → `"version": "0.35.3"` (bug fixes only → PATCH, per Versioning Rules).

- [ ] **Step 2: Add CHANGELOG entry**

Add at the top of `CHANGELOG.md`:

```markdown
## [0.35.3] - 2026-08-14

### Fixed
- **LSP dead for nested projects**: the workspace root is now resolved from the edited file's nearest project, using per-language markers declared in the LSP server config (`workspaceMarkers`). `typescript-language-server` could never find `typescript` when the project lived inside the agent baseDir, so every write/edit returned `[LSP check failed]: Could not find a valid TypeScript installation`.
- **Phantom "1 files missing" loop**: the final audit now requires files only from steps marked `done` and treats `skipped` as a terminal complete state. A skipped step's prose could previously poison the audit forever (a step referencing "type.ts" for the existing "types.ts" kept a finished task rejected).
- **Windows bash hints/block**: the win32 hint and hard-stop now key on the *original* command word. The `cat→type` translation previously hid `cat`/`ls`/`grep` failures from `UNIX_TO_WIN_HINTS`, so the model repeated them with no guidance.
- **read_file blindness at near-full context**: tools that declare `boundedOutput` (`read_file`, `list_dir`, `file_info`, `process_log`) are never budget-truncated. A `read_file` output was being cut to ~2K chars when the context was near-full, making the model re-read the same file 8+ times.
```

- [ ] **Step 3: Update AGENTS.md Current Version**

In the Current Version block, prepend the entry:

```markdown
- **37** = session control fixes (post-mortem `ses_mssx0k11`): (1) LSP workspace root resolved from the edited file's project via per-language `workspaceMarkers` in the LSP config (`findProjectRoot` in `src/modules/lsp/project-root.ts`) — nested projects got `[LSP check failed]: Could not find a valid TypeScript installation` on every write/edit; (2) the final audit requires files only from `done` steps and treats `skipped` as terminal — a skipped step's prose no longer produces a phantom "1 files missing" loop; (3) bash Windows hint/hard-block keys on the original command word (the `cat→type` translation defeated `UNIX_TO_WIN_HINTS`); (4) tools that declare `boundedOutput` on their `ToolDefinition` (`read_file`/`list_dir`/`file_info`/`process_log`) are never budget-truncated (near-full context was cutting read_file to ~2K chars, causing re-read loops). Version: 0.35.3.
```

- [ ] **Step 4: Verify + commit**

```bash
bun test
tsc --noEmit
git add package.json CHANGELOG.md AGENTS.md
git commit -m "chore: 0.35.3 — session control fixes (LSP root, audit statuses, bash hints, bounded output)"
```

---

## Self-Review

**Spec coverage:**
- Design spec §6.13.1 ("initialize (workspace root + capabilities)") — Task 1 makes the workspace root correct for nested projects, config-declared per language.
- Design spec §6.11 plan block + execution loop — Task 2 keeps the deliverable gate strict (the "mark done while file deleted" regression stays caught) and fixes the auditor's status handling.
- AGENTS.md rule #10 (no keyword matching) — no verb lists, no filename heuristics, no task classification. All special-casing is declarative data (`workspaceMarkers`, `boundedOutput`).
- AGENTS.md rule #8 (i18n) — no new user-facing strings; Tasks 3–4 reuse existing keys.
- Versioning Rules — all fixes are PATCH (bug fixes, no API/config schema/tool removal).

**Placeholder scan:** no TBD/TODO; every code step contains concrete code.

**Type consistency:** `findProjectRoot(filePath, baseDir, markers)` matches usage in `module.ts`; `LspServerConfig.workspaceMarkers` flows `types.ts` → `config.ts` → `module.ts`; `checkFile(..., projectRoot = baseDir)` matches `module.ts`; `toolOutputCharLimit(remaining, history, bounded)` matches `agent.ts`; `getAllForLLM` returns `boundedOutput` which `agent.ts` consumes.
