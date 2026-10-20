# Session Reliability Fixes Implementation Plan

**Goal:** Fix the 6 defects found in post-mortem analysis of session `ses_msrv83di_0hx6id` (56 forced compactions, LSP silently dead, plan steps marked done out of order / repeatedly without work, audit "finishing anyway", nested `<system-summary>` bloat, and the model repeating forbidden Unix commands in cmd.exe).

**Architecture:** Targeted fixes in 4 layers: (1) `ContextManager.getQuality()` — recoverable compaction penalty so quality can rise above the 40% forced-compaction trigger; (2) agent loop — forced-compaction cooldown + honest audit-gate failure instead of "finishing anyway"; (3) LSP — surface silent failures instead of `catch {}`; (4) execution module + bash — enforce sequential plan-step completion and hard-stop repeated forbidden commands.

**Tech Stack:** Bun, TypeScript, vitest (`bun test`), `tsc --noEmit`.

---

## File Structure

| File | Change |
|------|--------|
| `src/modules/context/manager.ts` | `getQuality()`: cap `compactionLoss` floor; `extractFacts()`: skip `<system-summary>` messages (kills nesting) |
| `src/core/agent.ts` | Forced-compaction cooldown; audit gate returns `success:false` when retries exhausted |
| `src/modules/lsp/module.ts` + `client.ts` | Log LSP failures, append `[LSP check failed]` note to tool output instead of silently returning empty |
| `src/modules/execution/module.ts` | `plan update`: refuse out-of-order `done`; warn on repeated `done` of an already-done step |
| `src/tools/bash.ts` | Module-level consecutive-failure counter per first word → hard directive after threshold |
| i18n | `en.json` + `ru.json`: new keys for plan-order refusal, LSP failure note, repeated-command block |

---

### Task 1: Recoverable context-quality penalty (death-spiral fix)

**Files:**
- Modify: `src/modules/context/manager.ts:151`
- Test: `tests/context-manager.test.ts`

- [x] **Step 1: Write failing tests**

Append to the `getQuality` describe block in `tests/context-manager.test.ts`:

```typescript
it("should not permanently zero out quality after many compactions", () => {
  const cm = new ContextManager(1000);
  cm.addMessage({ role: "system", content: "SYS" });
  // 20 compactions -> old formula clamps compactionLoss to 0 forever
  for (let c = 0; c < 20; c++) {
    for (let i = 0; i < 4; i++) {
      cm.addMessage({ role: "user", content: `msg ${c}:${i}` });
      cm.addMessage({ role: "assistant", content: `resp ${c}:${i}` });
    }
    cm.compact();
  }
  // Fresh context after compaction must have room to recover above the
  // 40% forced-compaction trigger, regardless of cumulative compaction count.
  const q = cm.getQuality();
  expect(q).toBeGreaterThanOrEqual(40);
});

it("should keep quality at least 40 with fresh context and high compaction count", () => {
  const cm = new ContextManager(32768);
  for (let c = 0; c < 10; c++) {
    cm.addMessage({ role: "user", content: `u${c}` });
    cm.addMessage({ role: "assistant", content: `a${c}` });
    cm.compact();
  }
  expect(cm.getQuality()).toBeGreaterThanOrEqual(40);
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test tests/context-manager.test.ts -t "permanently zero"` and `bun test tests/context-manager.test.ts -t "fresh context"`

Expected: FAIL — quality is stuck below 40 because `compactionLoss = max(0, 1 - compactionCount * 0.15)` is clamped to 0 after 7 compactions, and tokenLoad/errorDensity keep it under the trigger.

- [x] **Step 3: Implement — cap compactionLoss at a floor**

In `src/modules/context/manager.ts` replace line 151:

```typescript
const compactionLoss = Math.max(0, 1 - this.compactionCount * 0.15);
```

with:

```typescript
// Recoverable penalty: each compaction loses information, but the penalty is
// capped so cumulative compactions can NEVER permanently pin quality below
// the forced-compaction trigger (40%). A long session that compacted 50x must
// still be able to report "fresh context" after its latest compaction.
const COMPACTION_PENALTY_FLOOR = 0.5;
const compactionLoss = Math.max(
  COMPACTION_PENALTY_FLOOR,
  1 - this.compactionCount * 0.15,
);
```

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test tests/context-manager.test.ts`

Expected: PASS (all existing + new). Verify the two pre-existing compaction tests still hold (`decrease after compaction` still decreases since tokenLoad/freshness still move).

- [x] **Step 5: Commit**

```bash
git add tests/context-manager.test.ts src/modules/context/manager.ts
git commit -m "fix(context): cap compaction penalty so quality recovers above trigger"
```

---

### Task 2: Kill nested `<system-summary>` bloat

**Files:**
- Modify: `src/modules/context/manager.ts:343-411`
- Test: `tests/context-manager.test.ts`

- [x] **Step 1: Write failing test**

Append to `tests/context-manager.test.ts`:

```typescript
it("should not embed previous system-summary text into new error facts", () => {
  const cm = new ContextManager(1000);
  cm.addMessage({ role: "system", content: "SYS" });
  cm.addMessage({ role: "user", content: "task" });
  cm.addMessage({ role: "tool", name: "bash", content: "Error: build failed", success: false });
  cm.compact(); // summary #1 contains "[Errors: Error: build failed]"
  cm.addMessage({ role: "user", content: "more work" });
  cm.addMessage({ role: "tool", name: "bash", content: "Error: tests failed", success: false });
  cm.compact(); // summary #2 must NOT contain "<system-summary>" inside itself

  const history = cm.getActiveHistory();
  const summary = history.find((m) => typeof m.content === "string" && m.content.includes("[Compressed:"));
  expect(summary).toBeDefined();
  const text = typeof summary!.content === "string" ? summary!.content : "";
  const occurrences = text.split("<system-summary>").length - 1;
  expect(occurrences).toBeLessThanOrEqual(1); // only the wrapping tag, no nesting
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/context-manager.test.ts -t "should not embed previous system-summary"`

Expected: FAIL — error facts pulled from old `<system-summary>` messages get embedded raw into the next summary, producing `<system-summary>[... [Errors: <system-summary>...]`.

- [x] **Step 3: Implement — skip summary messages in extractFacts**

In `src/modules/context/manager.ts` `extractFacts`, at the top of the per-message loop (line ~354), skip already-summarized messages:

```typescript
for (const msg of turns) {
  const content = getMessageText(msg.content);

  // Never feed a previous <system-summary> block into new facts — that is
  // the source of recursive summary nesting (summary inside summary).
  if (
    msg.role === "user" &&
    (content.startsWith("<system-summary>") || content.includes("[Compressed:"))
  ) {
    continue;
  }
  ...
```

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test tests/context-manager.test.ts`

Expected: PASS. All existing compaction tests (keeping last 6, file/decision fact extraction) unaffected because they use plain user/assistant/tool messages.

- [x] **Step 5: Commit**

```bash
git add tests/context-manager.test.ts src/modules/context/manager.ts
git commit -m "fix(context): stop nesting system-summary blocks into new summaries"
```

---

### Task 3: Forced-compaction cooldown in the agent loop

**Files:**
- Modify: `src/core/agent.ts:30,365-380`
- Test: `tests/core/agent.test.ts`

- [x] **Step 1: Write failing test**

Add to `tests/core/agent.test.ts`:

```typescript
it("does not force a compaction on every single iteration when quality is low", async () => {
  let compactCalls = 0;
  let iter = 0;
  const deps = createMockDeps({
    config: { ...createMockDeps().config, maxToolIterations: 20 },
    contextManager: {
      noteIteration: () => { iter++; },
      needsCompaction: () => false,
      compact: () => { compactCalls++; },
      getEstimatedTokens: () => 100,
      getBudget: () => ({ history: 100 }),
      getQuality: () => 30, // below 40 trigger, compactionCount already > 0
      getCompactionCount: () => 5,
      getActiveHistory: () => [{ role: "user", content: "hello" }],
      addMessage: () => {},
      getIterationsSinceCompaction: () => 0,
    } as any,
  });
  const agent = new Agent(deps as any);
  await agent.run("hello");
  // A cooldown of >= 3 iterations means at most ~7 forced compactions in 20
  // iterations, NOT one per iteration (which was the death spiral).
  expect(compactCalls).toBeLessThanOrEqual(7);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/agent.test.ts -t "does not force a compaction on every single iteration"`

Expected: FAIL — currently `compact()` fires whenever `quality < 40 && compactionCount > 0`, i.e. every iteration.

- [x] **Step 3: Implement — add cooldown constant and guard**

In `src/core/agent.ts` add a constant near line 30:

```typescript
const FORCED_COMPACTION_COOLDOWN = 3;
```

In the `run()` method, before the loop, add a tracker field (e.g. `let lastForcedCompactionIteration = -Infinity;`). At the quality-trigger block (lines ~368-380), guard it:

```typescript
if (
  quality < QUALITY_TRIGGER_THRESHOLD &&
  contextManager.getCompactionCount() > 0 &&
  iteration - lastForcedCompactionIteration >= FORCED_COMPACTION_COOLDOWN
) {
  lastForcedCompactionIteration = iteration;
  contextManager.compact();
  logger.warn(`Low context quality (${quality}%) — forced compaction`);
  slog.logCompaction(
    `quality-triggered compaction (${quality}% < ${QUALITY_TRIGGER_THRESHOLD}%), iteration ${iteration}`,
    iteration,
    currentTokens,
    budget.history,
  );
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/agent.test.ts`

Expected: PASS (all existing + new). Existing audit/empty-response tests unaffected.

- [x] **Step 5: Commit**

```bash
git add tests/core/agent.test.ts src/core/agent.ts
git commit -m "fix(agent): cooldown between forced compactions breaks the death spiral"
```

---

### Task 4: Audit gate must not declare success when still failing

**Files:**
- Modify: `src/core/agent.ts:848-874`
- Test: `tests/core/agent.test.ts:870-906`

- [x] **Step 1: Write failing test**

Add to `tests/core/agent.test.ts`:

```typescript
it("returns success:false when the final audit is still failing after retries", async () => {
  const failingAudit = async () => ({
    passed: false,
    missingFiles: ["src/missing.ts"],
    createdFiles: [],
    modifiedFiles: [],
    summary: "Task incomplete: 0/1 steps done, 1 files missing",
    typeCheckError: null,
    massEditWarning: null,
    pendingSteps: ["Create src/missing.ts"],
  });
  const deps = createMockDeps({ finalAudit: failingAudit });
  const agent = new Agent(deps as any);
  const result = await agent.run("hello");
  expect(result.success).toBe(false);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/agent.test.ts -t "returns success:false when the final audit"`

Expected: FAIL — the loop `break`s after `MAX_AUDIT_RETRIES` and the result returns `success: true` (line 904 path).

- [x] **Step 3: Implement — flag audit failure into the result**

In `src/core/agent.ts`, introduce `let auditFailed = false;` near `auditRetries`. At the audit-retry-exhaustion branch (lines ~862-870) set the flag instead of plain `break`, then exit the loop:

```typescript
if (
  auditRetries >= MAX_AUDIT_RETRIES ||
  iteration >= config.maxToolIterations - 1
) {
  logger.warn(
    `Final audit still incomplete after ${auditRetries} retries — reporting failure`,
  );
  auditFailed = true;
  break;
}
```

At the final result construction (line ~903) reflect the flag:

```typescript
return {
  success: !emptyResponseExhausted && !auditFailed,
  text: lastText,
  error: emptyResponseExhausted
    ? t("error.empty_response")
    : auditFailed
      ? t("error.audit_failed", { summary: lastAuditSummary })
      : undefined,
  ...
};
```

Store `lastAuditSummary` when the audit fails (the `audit.summary` from the failing result) so the CLI reports WHY.

- [x] **Step 4: Update the existing test that asserted the old behavior**

In `tests/core/agent.test.ts:870` change `expect(result.success).toBe(true)` → `expect(result.success).toBe(false)`, and `expect(auditCalls).toBe(3)` stays.

- [x] **Step 5: Add i18n key**

In `src/i18n/en.json`:

```json
"error.audit_failed": "Task could not be verified as complete: {summary}"
```

In `src/i18n/ru.json`:

```json
"error.audit_failed": "Задача не может быть подтверждена как выполненная: {summary}"
```

- [x] **Step 6: Run all agent tests**

Run: `bun test tests/core/agent.test.ts`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/core/agent.ts src/i18n/en.json src/i18n/ru.json tests/core/agent.test.ts
git commit -m "fix(agent): report audit-gate failure instead of declaring success"
```

---

### Task 5: Surface LSP failures instead of swallowing them

**Files:**
- Modify: `src/modules/lsp/module.ts:32-60`, `src/modules/lsp/client.ts:77-82`
- Test: `tests/lsp-module.test.ts` (new)

- [x] **Step 1: Write failing test**

Create `tests/lsp-module.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { LspModule } from "../src/modules/lsp/module";

describe("LspModule", () => {
  it("appends an LSP check failed note when the server cannot start", async () => {
    const module = new LspModule({ enabled: true } as any);
    const plugin = module.getPlugin();
    const result = { success: true, output: "file written ok" };
    const ctx = {
      baseDir: "/tmp",
      logger: { warn: () => {} },
    } as any;
    // Force the internal client to fail: monkey-patch checkFile via the module.
    (module as any).client.checkFile = async () => {
      throw new Error("npx typescript-language-server not found");
    };
    await plugin.onAfterTool!(ctx, { name: "write_file", arguments: { path: "src/a.ts" } }, result);
    expect(result.output).toContain("[LSP check failed]");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/lsp-module.test.ts`

Expected: FAIL — the plugin's `catch {}` swallows the error and output is unchanged.

- [x] **Step 3: Implement — log and annotate on failure**

In `src/modules/lsp/module.ts` replace the bare `catch {}` (line ~59):

```typescript
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  try { (_ctx as { logger?: { warn(m: string): void } }).logger?.warn(`LSP check failed for ${filePath}: ${msg}`); } catch {}
  result.output += `\n\n[LSP check failed]: ${msg}`;
}
```

In `src/modules/lsp/client.ts`, replace `catch { return []; }` (lines ~77-78) so failures propagate to the module (the module now logs/annotates instead of a silent empty array):

```typescript
} catch (e) {
  throw e instanceof Error ? e : new Error(String(e));
} finally {
  await this.shutdown();
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test tests/lsp-module.test.ts`

Expected: PASS.

- [x] **Step 5: Run typecheck**

Run: `tsc --noEmit`

Expected: no new errors (the `(_ctx as ...)` cast keeps types happy).

- [x] **Step 6: Commit**

```bash
git add src/modules/lsp/module.ts src/modules/lsp/client.ts tests/lsp-module.test.ts
git commit -m "fix(lsp): surface server failures instead of silently returning empty diagnostics"
```

---

### Task 6: Refuse out-of-order plan completion; warn on repeated `done`

**Files:**
- Modify: `src/modules/execution/module.ts:290-310`
- Test: `tests/tools/execution-tools.test.ts`
- i18n: `en.json`, `ru.json`

- [x] **Step 1: Write failing tests**

Append to `tests/tools/execution-tools.test.ts` (inside the `plan tool` describe):

```typescript
it("refuses to mark a later step done before earlier steps", async () => {
  const tools = execModule.getToolDefinitions();
  const planTool = tools.find((t) => t.name === "plan")!;
  const ctx = { logger: { warn: () => {} } } as any;

  await planTool.handler(ctx, {
    action: "create", title: "T",
    steps: ["First step with enough chars", "Second step with enough chars", "Third step with enough chars"],
  });

  const result = await planTool.handler(ctx, { action: "update", step: 3, status: "done" });
  expect(result.success).toBe(false);
  expect(result.output).toContain("step 1");
});

it("warns when marking an already-done step done again", async () => {
  const tools = execModule.getToolDefinitions();
  const planTool = tools.find((t) => t.name === "plan")!;
  const ctx = { logger: { warn: () => {} } } as any;

  await planTool.handler(ctx, {
    action: "create", title: "T",
    steps: ["First step with enough chars", "Second step with enough chars"],
  });
  await planTool.handler(ctx, { action: "update", step: 1, status: "done" });
  const second = await planTool.handler(ctx, { action: "update", step: 1, status: "done" });
  expect(second.success).toBe(false);
  expect(second.output).toContain("already");
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test tests/tools/execution-tools.test.ts`

Expected: FAIL — currently any step can be marked done anytime and repeated without complaint.

- [x] **Step 3: Implement — order + idempotency guards**

In `src/modules/execution/module.ts`, in the `action === "update" && args.step` handler (line ~290), before calling `updateStepStatus`, add:

```typescript
const stepId = Number(args.step);
const target = this.tracker.getStep(stepId);
if (!target) {
  return { success: false, output: t("plan.step_not_found") };
}
const status = String(args.status || "done");

// Idempotency: re-marking a done step as done is a no-op that usually means
// the model is spinning. Flag it so it stops repeating itself.
if (status === "done" && target.status === "done") {
  return { success: false, output: t("plan.step_already_done", { step: String(stepId) }) };
}

// Order enforcement: you may only mark the CURRENT step done (all earlier
// steps must be done/skipped). Prevents jumping ahead (step 5 before 1-4).
if (status === "done") {
  const blockers = this.tracker
    .getPlan()
    .steps.filter((s) => s.id < stepId && s.status !== "done" && s.status !== "skipped");
  if (blockers.length > 0) {
    return {
      success: false,
      output: t("plan.order_blocked", {
        step: String(stepId),
        first: String(blockers[0].id),
        desc: blockers[0].description,
      }),
    };
  }
}

this.tracker.updateStepStatus(stepId, status as any);
```

(`skipped`/`failed` out of order remain allowed — the model can skip a step it doesn't need; only `done` requires predecessors to be finished.)

- [x] **Step 4: Add i18n keys**

`en.json`:

```json
"plan.step_already_done": "Step {step} is already marked done. Stop re-marking it — either continue with the next step or investigate why progress appears stuck.",
"plan.order_blocked": "Cannot mark step {step} done: step {first} (\"{desc}\") is not finished yet. Complete earlier steps first, or mark step {first} status=skipped if it is not needed."
```

`ru.json`:

```json
"plan.step_already_done": "Шаг {step} уже отмечен выполненным. Прекратите повторную отметку — переходите к следующему шагу или выясните, почему прогресс заблокирован.",
"plan.order_blocked": "Нельзя отметить шаг {step} выполненным: шаг {first} («{desc}») ещё не завершён. Сначала завершите предыдущие шаги или отметьте шаг {first} status=skipped, если он не нужен."
```

- [x] **Step 5: Run tests + typecheck**

Run: `bun test tests/tools/execution-tools.test.ts` and `tsc --noEmit`

Expected: PASS, no new type errors.

- [x] **Step 6: Commit**

```bash
git add src/modules/execution/module.ts src/i18n/en.json src/i18n/ru.json tests/tools/execution-tools.test.ts
git commit -m "fix(execution): enforce sequential plan-step done and warn on repeated done"
```

---

### Task 7: Hard-stop repeated forbidden commands in bash

**Files:**
- Modify: `src/tools/bash.ts`
- Test: `tests/bash.test.ts`

- [x] **Step 1: Write failing test**

Append to `tests/bash.test.ts`:

```typescript
it("hard-blocks a command after repeated consecutive failures", async () => {
  const module = await import("../src/tools/bash");
  // reset module state
  (module as any).resetBashFailureTracking?.();
  const tool = module.bashTool;
  const ctx = { baseDir: "/tmp", logger: { warn: () => {} } } as any;

  // Simulate: "head" not recognized in cmd.exe 3 times in a row
  for (let i = 0; i < 3; i++) {
    const r = await tool.handler(ctx, { command: "head -30 file.txt" });
    if (i < 2) {
      expect(r.output).toContain("Hint");
    } else {
      expect(r.output).toContain("STOP");
    }
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/bash.test.ts -t "hard-blocks"`

Expected: FAIL — the tool only ever appends a hint; no escalation.

- [x] **Step 3: Implement — module-level consecutive-failure counter**

In `src/tools/bash.ts`, add near the top:

```typescript
/** Consecutive failures per first command word (resets on success). */
const FAILING_FIRST_WORDS = new Map<string, number>();
const HARD_BLOCK_THRESHOLD = 3;

export function resetBashFailureTracking(): void {
  FAILING_FIRST_WORDS.clear();
}
```

In the failure path (after `code !== 0`, before/inside the Windows-hint block ~line 464), compute the first word and escalate:

```typescript
if (platform() === "win32" && code !== 0) {
  const firstWord = command.trim().split(/\s+/)[0]?.split(/[\\/]/).pop();
  const hint = firstWord ? UNIX_TO_WIN_HINTS[firstWord] : undefined;
  if (firstWord && firstWord in UNIX_TO_WIN_HINTS) {
    const failures = (FAILING_FIRST_WORDS.get(firstWord) || 0) + 1;
    FAILING_FIRST_WORDS.set(firstWord, failures);
    if (failures >= HARD_BLOCK_THRESHOLD) {
      output = `STOP using "${firstWord}" — it does not work in this cmd.exe shell and has failed ${failures} times in a row. ${hint ?? ""}`;
    } else {
      output = `${output}\n\nHint: "${firstWord}" may not work on Windows. ${hint ?? ""}`;
    }
  }
}
```

(Reset the counter on `code === 0` for the same first word.)

- [x] **Step 4: Run test + existing bash tests**

Run: `bun test tests/bash.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/tools/bash.ts tests/bash.test.ts
git commit -m "fix(bash): hard-stop repeated forbidden commands on Windows"
```

---

### Task 8: Verify — full suite + typecheck + real-agent smoke run

- [x] **Step 1: Full test suite**

Run: `bun test`

Expected: all tests pass.

- [x] **Step 2: Typecheck**

Run: `tsc --noEmit`

Expected: no errors.

- [x] **Step 3: Real-agent smoke run**

Run in the sandbox (per AGENTS.md):

```bash
bun run mma "create a hello.txt file with content 'hi' then mark the plan step done" --no-agents-md --exit-on-complete -d _testing/smoke-plan-order
```

Expected: agent refuses to mark step 2 done before step 1; no unbounded forced compaction warnings.

- [x] **Step 4: Update CHANGELOG / AGENTS.md**

Add a PATCH note to `AGENTS.md` version history (next version line): context-quality penalty floor + forced-compaction cooldown, nested system-summary fix, audit-gate honest failure, LSP failure surfacing, sequential plan-step enforcement, bash repeated-command hard-stop.

- [x] **Step 5: Commit**

```bash
git add AGENTS.md
git commit -m "docs: note session-reliability fixes"
```

---

## Self-Review

**1. Spec coverage (6 session defects):**
- Context compaction death spiral → Tasks 1 + 3 ✓
- Nested summary bloat → Task 2 ✓
- LSP silently dead → Task 5 ✓
- Plan out-of-order + repeated false `done` → Task 6 ✓
- Audit "finishing anyway" → Task 4 ✓
- Model отсебятина / repeated forbidden commands → Task 7 ✓

**2. Placeholder scan:** All steps contain concrete code + exact commands. No TODOs.

**3. Type consistency:** `plan.order_blocked`/`plan.step_already_done` used consistently in module.ts and both i18n files; `error.audit_failed` used in agent.ts and both i18n files; `resetBashFailureTracking` exported and referenced in the test.

