# Plan: Code-level validation to compensate for 9B model weaknesses

## Status: IMPLEMENTED (2026-07-22)

**Реализовано:**
- Phase 1.1: `getPlanStepTitle()`, `getNextPendingStep()`, `extractDirFromStepTitle()` в plan.ts
- Phase 1.2: Авто-пометка pending шага как in_progress перед subagent (loop.ts)
- Phase 1.3: Валидация done для несуществующих/уже-done шагов, skip action (native/plan.ts)
- Phase 2.1: Валидация путей созданных файлов subagent (loop.ts)
- Phase 2.3: Авто-инъекция пути директории в task subagent (loop.ts)
- Phase 4.1: Аудит файлов при завершении плана (loop.ts)
- Phase 5.1: Расширенный uselessActionCount — read_file/grep_search повторы (loop.ts)
- Phase 6.1: Исправлен clearPlan require() → импорт (plan.ts)
- Phase 6.2: Добавлен skip action (native/plan.ts)

**Убрано по ревью:**
- Phase 3.1 (scaffold hint) — low value, high complexity
- Phase 4.2 (auto build) — неожиданно для пользователя
- Phase 5.2 (track files outside plan) — шум без пользы

## Problem Statement

Qwen3.5-9B model reliably:
- Creates files in wrong directories (root instead of todo-app/)
- Skips files in plans (tsconfig.json missing)
- Ignores "1 file = 1 subagent" rule
- Doesn't use scaffold tool when instructed
- Calls `plan({action:"done", step:N})` with non-existent step numbers
- Creates extra files beyond task scope

The agent code must compensate by validating and auto-correcting model behavior.

---

## Phase 1: Plan completion validation (loop.ts)

### 1.1 Auto-verify plan files exist before allowing completion

**File:** `src/agent/loop.ts` — plan enforcement block (lines 633-649)

When model claims "done" but plan has pending steps, currently only injects a nudge message. Add:

- After each `plan({action:"done", step:N})` call, check if expected files from that step actually exist on disk
- If step says "Create package.json" but `package.json` doesn't exist → inject error: "Step N claims package.json was created but file doesn't exist. Fix this before continuing."
- Use `getPlanStepTitle(stepId)` to extract expected file name from step title
- Check with `existsSync()`

**New function in `src/tools/plan.ts`:**
```ts
export function getPlanStepTitle(stepId: number): string | null {
  const plan = loadPlan();
  if (!plan) return null;
  const step = plan.steps.find(s => s.id === stepId);
  return step?.title ?? null;
}
```

### 1.2 Auto-mark step as in_progress when subagent starts

**File:** `src/agent/loop.ts` — after subagent call

When a subagent is called and the plan is active:
- Find the next pending step
- Auto-set it to `in_progress` (call `updatePlanStep(nextPendingId, 'in_progress')`)
- This gives the model a visual cue about which step is active

### 1.3 Prevent plan({action:"done"}) for already-done steps

**File:** `src/tools/native/plan.ts` — done action

When `plan({action:"done", step:N})` is called:
- If step is already `done` → return "Step N is already done. Nothing to do."
- If step is `in_progress` → mark as `done` (normal flow)
- If step is `pending` → mark as `done` (model skipped in_progress, allow it)

---

## Phase 2: Subagent path validation (loop.ts)

### 2.1 Validate subagent created files in correct directory

**File:** `src/agent/loop.ts` — after subagent completes

When subagent returns `createdFiles`:
- If parent plan says "Create todo-app/package.json" but subagent created "package.json" (in root) → inject correction: "File package.json was created in the wrong directory. It should be in todo-app/. Use write_file with full path: todo-app/package.json"
- Compare each `createdFiles[i]` against the expected path from the plan step
- Extract expected path from step title (e.g., "Create todo-app/package.json" → "todo-app/package.json")

### 2.2 Auto-create missing parent directories

**File:** `src/tools/fs/write-file.ts`

Before writing a file, check if parent directory exists:
- If not, create it automatically (already done by `mkdirSync(dir, { recursive: true })`)
- This already works — the issue is the model doesn't use full paths

### 2.3 Inject full paths into subagent task when plan is active

**File:** `src/agent/loop.ts` — subagent call interception

When model calls `subagent({task:"Create package.json", ...})` and a plan is active:
- Find the matching plan step (fuzzy match on file name)
- Auto-prepend the directory path to the task: "Create todo-app/package.json"
- This compensates for model's failure to include full paths

---

## Phase 3: Scaffold enforcement (loop.ts)

### 3.1 Auto-scaffold when model tries to create known project types

**File:** `src/agent/loop.ts` — before subagent execution

When model creates a project with 5+ files that match a known template:
- Detect: if plan has steps like "package.json + vite.config.ts + tsconfig.json + index.html + src/main.tsx"
- Auto-inject: "Consider using scaffold({template:'vite-react-ts', dir:'todo-app'}) instead of creating files manually"
- This is a HINT, not a block — model can still ignore it

### 3.2 Validate scaffold output

**File:** `src/tools/native/scaffold.ts`

After scaffold creates files:
- Verify all template files were created
- If any file is missing → return error with list of missing files
- This catches bugs in the scaffold tool itself

---

## Phase 4: File completeness check (loop.ts)

### 4.1 Post-plan completion file audit

**File:** `src/agent/loop.ts` — when all plan steps are done

When `getPlanPendingCount() === 0` (all steps done):
- Scan the plan steps and extract expected file paths
- Check each file exists on disk
- If any file is missing → inject: "Plan claims all steps done, but these files are missing: X, Y, Z. Create them before finishing."
- Only check files that are mentioned in step titles (don't check for files not in the plan)

### 4.2 Build verification auto-trigger

**File:** `src/agent/loop.ts` — when plan completes

When all plan steps are done AND the project has a `package.json` with a `build` script:
- Auto-run `npm run build` or `tsc --noEmit` in background
- If build fails → inject error with build output
- This catches TypeScript errors that the model claims are fixed but aren't

---

## Phase 5: Stuck detection improvements (loop.ts)

### 5.1 Expand useless action detection

**File:** `src/agent/loop.ts` — uselessActionCount logic (lines 652-674)

Current: only counts `list_dir`, `tree`, `todo list`
Add: `read_file` of the same file 2+ times (model is confused, re-reading same file)
Add: `grep_search` with same pattern 2+ times (model is searching for something it already found)

### 5.2 Auto-clear plan when model creates files outside plan scope

**File:** `src/agent/loop.ts` — after write_file

When model creates a file via `write_file` that is NOT in the plan steps:
- Log warning: "File X was created but is not in the plan. Did you forget to add it?"
- Don't block (file might be legitimate), but track it

---

## Phase 6: Bug fixes

### 6.1 Fix clearPlan require() usage

**File:** `src/tools/plan.ts` — line 97

Replace `require('node:fs').unlinkSync(PLAN_FILE)` with the imported `unlinkSync` (already imported at top of file).

### 6.2 Add skip action to plan handler

**File:** `src/tools/native/plan.ts`

Add `skip` to the action enum and handler:
```ts
case 'skip': {
  const stepNum = Number(args.step);
  if (!stepNum || stepNum < 1) {
    output = 'Usage: plan({action:"skip", step:N}) — marks step N as skipped.';
  } else {
    output = updatePlanStep(stepNum, 'skipped');
  }
  break;
}
```

---

## Files to modify

| File | Changes |
|------|---------|
| `src/agent/loop.ts` | Phases 1-5: plan validation, subagent path validation, scaffold hints, file audit, stuck detection |
| `src/tools/plan.ts` | Phase 1: getPlanStepTitle(), fix clearPlan require() |
| `src/tools/native/plan.ts` | Phase 1.3: done validation, Phase 6.2: skip action |
| `src/tools/native/scaffold.ts` | Phase 3.2: post-scaffold verification |
| `src/tools/fs/write-file.ts` | Phase 2.2: already handles dir creation (no change needed) |

---

## Verification

1. **Unit tests:** Add tests for new plan functions (getPlanStepTitle, skip action)
2. **Integration test:** Run `test-agent-conversation.ts --scenario react-todo --keep` and verify:
   - All files created in correct directory (todo-app/)
   - No extra files in root
   - Plan completes with all files present
   - Build passes (tsc --noEmit)
3. **Eval test:** Run `test-agent-eval.ts` — all scenarios should still be A
4. **Manual check:** Verify no regressions in existing functionality
