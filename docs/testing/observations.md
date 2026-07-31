# MMA v2 Test Observations Log

Record of issues found during interactive testing. Each entry includes context, reproduction steps, and suggested fix.

---

## OBS-001: Hallucination Detector False Positive on glob-tool Results

**Date**: 2026-07-31
**Test**: Category 2, Scenario 2.1 — List & Read Files
**Severity**: Medium (noise in output, may confuse model)
**Component**: `src/modules/hallucination/factual.ts` — `FactualCheck`

### Description
After successful `glob-tool` + `read-file` execution, the hallucination detector emitted a warning:
```
[WARN] Hallucination warning: Упомянутые файлы не найдены: src/cli/commands.ts, src/cli/completer.ts, src/cli/index.ts
```

The files **do exist** on disk and were correctly returned by `glob-tool`. The detector incorrectly flagged them as hallucinated.

### Reproduction
1. Run: `bun run src/cli/main.ts "Find all TypeScript files in the src/cli directory and show me the first 30 lines of main.ts" --no-agents-md`
2. Agent calls `glob-tool` → returns 6 files
3. Agent calls `read-file` on `main.ts` → returns content
4. Hallucination check runs → warns about 3 of the 6 files

### Root Cause Hypothesis
`FactualCheck` tracks "known paths" via `trackReadPath()` / `trackCreatedPath()` called from tool context. The `glob-tool` results may not be fed into the known-paths set, or the check runs before glob results are registered.

In `bootstrap.ts` lines 245-246:
```typescript
toolCtx.trackReadPath = (p) => factualCheck.trackReadPath(p);
toolCtx.trackCreatedPath = (p) => factualCheck.trackCreatedPath(p);
```

But `glob-tool` doesn't call `trackReadPath` for its results — it only returns them to the model. The model then mentions them in its response, triggering the check against an incomplete known-paths set.

### Suggested Fix
Option A: Make `glob-tool` / `grep-tool` / `list-dir` call `trackReadPath` for each returned path (if they're real files).

Option B: In `FactualCheck`, also check against actual filesystem (`existsSync`) before warning — if file exists, it's not a hallucination.

Option C: Expand known-paths set at agent startup with project-map index (all indexed files are "known").

**Preferred**: Option B — ground truth is filesystem. Cheap `existsSync` check eliminates false positives for real files.

### Files to Modify
- `src/modules/hallucination/factual.ts` — add `existsSync` check in `check()` before warning

### Test to Verify Fix
Re-run Scenario 2.1 — warning should not appear for files that exist on disk.

---

## OBS-002: write-file Tool Receives Corrupted Content (Includes CLI Flags)

**Date**: 2026-07-31
**Test**: Category 2, Scenario 2.2 — Create Single File
**Severity**: High (file content corrupted)
**Component**: `src/tools/write-file.ts` or agent prompt parsing / tool parameter extraction

### Description
Requested: `Create a file hello.ts with content: export const msg = "Hello, MMA!";`

Actual file content written:
```
export const msg = " Hello MMA!\; --no-agents-md
```

The content includes:
- Extra space after opening quote
- Backslash before semicolon
- The CLI flag `--no-agents-md` appended

Syntax check failed: `Unterminated string literal` at position 49.

### Reproduction
1. Run: `bun run src/cli/main.ts "Create a file hello.ts with content: export const msg = \"Hello, MMA!\";" --no-agents-md`
2. Agent calls `write-file` with corrupted content
3. File created with garbage content
4. Lint plugin runs, reports syntax error

### Root Cause Hypothesis
The model's tool call arguments are being constructed incorrectly. Possible causes:

1. **Prompt parsing**: The model sees the full command line including `--no-agents-md` and includes it in the content parameter
2. **Tool parameter extraction**: JSON parsing of tool arguments fails or merges with remaining CLI args
3. **Escaping issue**: Quotes in the prompt not properly escaped when passed to model

The model response said: "The file was created with your exact requested content, including the intentional syntax error" — suggesting the model *thought* it received that content, or it's hallucinating the tool call result.

### Suggested Fix
1. Check `write-file.ts` handler — how it receives `content` parameter
2. Verify tool call argument parsing in `openai-compat.ts` / `response.ts`
3. Ensure CLI flags (`--no-agents-md`) are stripped before prompt reaches model
4. Add validation in `write-file` tool: reject content containing CLI-like flags

### Files to Modify
- `src/tools/write-file.ts` — add content validation/sanitization
- `src/cli/main.ts` — ensure prompt args don't include flags when passed to agent
- `src/llm/openai-compat.ts` — verify tool call argument parsing

### Test to Verify Fix
Re-run Scenario 2.2 — file should contain exactly: `export const msg = "Hello, MMA!";`

---

## OBS-003: edit-file Not Used; write-file Overwrites; String Interpolation Bug; System Message Jinja Error

**Date**: 2026-07-31
**Test**: Category 2, Scenario 2.4 — Edit File (Find-Replace)
**Severity**: High (multiple issues)
**Component**: `src/tools/edit-file.ts`, `src/tools/write-file.ts`, `src/core/agent.ts`, `src/llm/openai-compat.ts`

### Description
Multiple issues observed in single test run:

1. **Wrong tool used**: Model called `write-file` (full overwrite) instead of `edit-file` (find-replace) despite explicit "change the add function" instruction.

2. **String interpolation bug**: Output contains `console.log(" Adding a, b")` — variables `a, b` are literal string content, not interpolated. Should be `console.log("Adding", a, b)` or template literal.

3. **Critical: "System message must be at the beginning" Jinja error** — After the write, the agent loop continued and hit the Jinja template error (same as documented in AGENTS.md). This caused:
   - 400 errors from llama.cpp
   - Hallucination retries (3x)
   - Stuck detector triggered (9-12 iterations)
   - Final error: "Модель вернула пустой или недостаточный ответ после нескольких попыток"

4. **Stuck detector false positive**: "Застряли на шаге 0" — step tracking not working properly.

### Reproduction
1. Create test-edit.ts with original function
2. Run edit prompt
3. Observe: write-file used, content bug, then Jinja error cascade

### Root Cause Hypothesis

**Issue 1 (wrong tool)**: Model not reliably choosing edit-file. May need stronger prompt guidance or edit-file description improvement.

**Issue 2 (interpolation)**: Model hallucinated incorrect syntax. Could be model limitation (Qwen 3.5-9B).

**Issue 3 (Jinja error)**: **This is the known AGENTS.md issue**. After tool execution, `agent.ts` adds a summary as `role: "system"` message, violating Jinja template requirement that system must be first. The fix in AGENTS.md says to use `role: "user"` with `<system-summary>` wrapper. This fix may not be fully applied or regressed.

**Issue 4 (stuck detector)**: Step ID is 0/empty — plan tracking not initialized properly for non-plan tasks.

### Suggested Fixes

1. **Fix Jinja system message** (priority): In `src/core/agent.ts`, ensure post-tool summaries use `role: "user"` with `<system-summary>` wrapper, never `role: "system"`.

2. **Improve edit-file prompt/description**: Make it clearer when to use edit vs write.

3. **Fix stuck detector**: Don't track "step 0" for tasks without explicit plan.

4. **Model limitation**: Accept that 9B model may mishandle string interpolation; consider adding example in prompt.

### Files to Modify
- `src/core/agent.ts` — verify system message fix applied
- `src/tools/edit-file.ts` — improve description
- `src/modules/execution/stuck-detector.ts` — handle no-plan case

### Test to Verify Fix
Re-run Scenario 2.4 — should use edit-file, correct interpolation, no Jinja errors, no stuck warnings.

---

## OBS-004: (Template for next observations)

**Date**: 
**Test**: 
**Severity**: 
**Component**: 

### Description


### Reproduction


### Root Cause Hypothesis


### Suggested Fix


### Files to Modify


### Test to Verify Fix

---