# Implementation Plan — Agent-Level MoE

**Source spec:** `docs/specs/2025-07-30-agent-level-moe.md`
**Status:** ready to implement  
**MVP goal:** Router + Expert-Agent + Expert-Tools, no scope expansion, no per-expert quantization.

---

## Phase 0 — Tool tagging

**Goal:** every tool gets a `tags` field; the system can filter tools by tags.

### Tasks

1. Add `tags?: string[]` to `ToolDefinition` in `src/tools/types.ts`.
2. Tag all tools in `src/tools/registry.ts` with relevant tags: `file`, `code`, `shell`, `research`, `browser`, `design`, `vision`.
3. Create `src/tools/filter-tools.ts` with `filterToolsByTags(tools, toolTags)`.
4. Add tests: `tests/tools/filter-tools.test.ts`.

### Acceptance criteria

- `tsc --noEmit` passes.
- `bun test tests/tools/filter-tools.test.ts` passes.
- `tools/registry.ts` has no untagged tool.

### Files to change

- `src/tools/types.ts`
- `src/tools/registry.ts`
- `src/tools/filter-tools.ts`
- `tests/tools/filter-tools.test.ts`

---

## Phase 1 — Expert registry in config

**Goal:** config can declare experts with model, tool tags, and retry policy.

### Tasks

1. Add types in `src/config/types.ts`:
   ```typescript
   export interface ExpertConfig {
     model: string;
     tool_tags: string[];
     max_attempts?: number;
   }
   export interface AppConfig {
     experts: Record<string, ExpertConfig>;
   }
   ```
2. Add default `experts` block in `src/config/defaults.ts`:
   - `code`, `research`, `browser`, `vision`.
3. Add `getExpertConfig(tag)` helper.
4. Add validation: every `tool_tag` must exist in at least one tool.
5. Add tests for config defaults and validation.

### Acceptance criteria

- `tsc --noEmit` passes.
- `bun test tests/config/` passes.
- Unknown `tool_tag` in config throws on startup.

### Files to change

- `src/config/types.ts`
- `src/config/defaults.ts`
- `src/config/loader.ts` or new `src/config/experts.ts`
- `tests/config/defaults.test.ts`

---

## Phase 2 — Subagent scope enforcement

**Goal:** subagent runs with a strict `allowed_files` / `read_only_files` / `max_tokens` envelope.

### Tasks

1. Extend `subagent` tool schema in `src/tools/subagent.ts` to accept:
   - `expert_tag`
   - `allowed_files`
   - `read_only_files`
   - `shared_context`
   - `max_tokens`
2. Pass scope into the spawned subagent context.
3. Update `read_file`, `write_file`, `edit_file`, `bash`, `move_file`, `delete_file` to check target path against the active scope.
4. Add tests for scope rejection and allowed reads.

### Acceptance criteria

- Subagent cannot read a file outside `allowed_files` + `read_only_files`.
- Subagent cannot write/delete a file outside `allowed_files`.
- `bun test tests/tools/subagent-scope.test.ts` passes.

### Files to change

- `src/tools/subagent.ts`
- `src/tools/read-file.ts`
- `src/tools/write-file.ts`
- `src/tools/edit-file.ts`
- `src/tools/bash.ts`
- `src/tools/delete-file.ts`
- `src/tools/move-file.ts`
- `src/tools/types.ts` (ToolContext gains `scope`)

---

## Phase 3 — Plan validation

**Goal:** validate a Router plan before execution.

### Tasks

1. Create `src/modules/execution/plan-validator.ts` with functions:
   - `validatePlan(plan)`
   - `hasAllowedFilesOverlap(subtasks)`
   - `hasCycle(subtasks)` — topological check.
   - `expertTagsExist(subtasks, config)`
   - `deleteReadOverlap(subtasks)` — delete-read dependency check.
2. Auto-fix minor issues: add `depends_on` for read-after-write overlaps when safe.
3. Add tests: `tests/modules/execution/plan-validator.test.ts`.

### Acceptance criteria

- Write-write overlap in `allowed_files` is rejected.
- Read-after-write overlap without `depends_on` is auto-fixed or rejected.
- DAG cycle is rejected.
- Unknown `expert_tag` is rejected.

### Files to change

- `src/modules/execution/plan-validator.ts`
- `tests/modules/execution/plan-validator.test.ts`

---

## Phase 4 — Orchestrator Router modes

**Goal:** `orchestrator.ts` can produce a plan and later verify/merge results.

### Tasks

1. Refactor `src/llm/orchestrator.ts`:
   - `plan(userPrompt, context) -> MoEPlan`
   - `verifyAndMerge(plan, results, verifierOutput) -> finalResult | newPlan`
2. Add system prompts for both modes.
   - Plan mode: strong JSON schema + no keyword matching reminder.
   - Verify mode: receives plan, results, verifier errors.
3. Parse JSON output robustly (jsonrepair already in deps).

### Acceptance criteria

- `plan()` returns a valid `MoEPlan` for a simple multi-step task.
- `verifyAndMerge()` returns a final answer when all subtasks succeed.
- `verifyAndMerge()` returns a new plan with ≤3 cycles.

### Files to change

- `src/llm/orchestrator.ts`
- `src/llm/types.ts` (add `MoEPlan`, `Subtask`, `SharedContext`)
- `tests/llm/orchestrator-modes.test.ts` (mocked LLM)

---

## Phase 5 — Plan execution engine

**Goal:** execute a validated plan with parallelism and dependency ordering.

### Tasks

1. Create `src/modules/execution/moe-executor.ts`:
   - `executePlan(plan, context)`
   - Topological sort using `depends_on`.
   - Parallel execution of ready subtasks.
   - Collect `sub-session`, `summary`, `result` for each.
2. For each subtask, spawn `subagent` with:
   - filtered tool list via `filterToolsByTags`
   - model from `experts[expert_tag].model`
   - `max_tokens` from subtask or expert default
   - `allowed_files`, `read_only_files`, `shared_context`
3. Add `chain_max_attempts` for dependent chains (post-MVP optional, but stub now).
4. Add tests with mocked LLM.

### Acceptance criteria

- Independent subtasks run in parallel.
- Dependent subtasks run in correct order.
- Failure of one subtask does not abort others.
- Results are collected and passed to Router.

### Files to change

- `src/modules/execution/moe-executor.ts`
- `src/modules/execution/types.ts` (add `SubtaskResult`, `PlanResult`)
- `tests/modules/execution/moe-executor.test.ts`

---

## Phase 6 — Prompt builder integration

**Goal:** only the relevant tools and context are shown to an expert.

### Tasks

1. Update `src/core/prompt-builder.ts` to support filtering tools by `expert_tag`.
2. Ensure system prompt includes `shared_context.rules` and `shared_context.refs`.
3. Include `input_from` data in the subtask prompt.

### Acceptance criteria

- Subagent prompt contains only tools whose tags intersect `experts[expert_tag].tool_tags`.
- `shared_context` is present in the system prompt.

### Files to change

- `src/core/prompt-builder.ts`
- `src/core/types.ts` (add `SubtaskContext`)

---

## Phase 7 — Retry and failure handling

**Goal:** transient failures retry, structural failures re-plan.

### Tasks

1. Add `max_attempts` retry wrapper in `moe-executor.ts`.
2. Classify failures:
   - Transient: LLM timeout, network 5xx, browser timeout.
   - Structural: scope violation, syntax error, failed success criteria.
3. Structural failures feed into `verifyAndMerge` re-plan.
4. Enforce `max_replan_cycles = 3`.

### Acceptance criteria

- Browser timeout triggers retry up to `max_attempts`.
- Scope violation does not retry; triggers re-plan.
- After 3 re-plan cycles, Router returns partial result with explanation.

### Files to change

- `src/modules/execution/moe-executor.ts`
- `src/llm/orchestrator.ts`

---

## Phase 8 — Global verification

**Goal:** Router runs verification after all subtasks.

### Tasks

1. Extend `src/modules/execution/verifier.ts` to accept a list of artifacts and run:
   - `tsc --noEmit`
   - `bun test`
   - File existence checks
   - Consistency checks (e.g., `experts.vision.tool_tags` are present in tools)
2. Return structured output: `{ success, errors, warnings }`.

### Acceptance criteria

- Verifier runs after all subtasks complete.
- Errors are passed back to Router for re-plan.

### Files to change

- `src/modules/execution/verifier.ts`
- `tests/modules/execution/verifier.test.ts`

---

## Phase 9 — Integration and wiring

**Goal:** the main agent loop can trigger MoE when appropriate.

### Tasks

1. In `src/core/agent.ts`, add a decision point: if task is multi-step and `moe.enabled`, use Orchestrator Router instead of single-agent loop.
2. Wire `plan -> validate -> execute -> verify/merge -> output`.
3. Keep the existing single-agent path as fallback.

### Acceptance criteria

- A simple multi-step task (e.g., the tagging task) runs through MoE end-to-end.
- Single-step tasks still use the existing agent loop.

### Files to change

- `src/core/agent.ts`
- `src/config/defaults.ts` (add `moe.enabled`)

---

## Phase 10 — Documentation and AGENTS.md update

**Goal:** project documentation reflects the new architecture.

### Tasks

1. Update `AGENTS.md` to move Agent-Level MoE from "in spec" to "partially implemented".
2. Add `docs/specs/2025-07-30-agent-level-moe-plan.md` (this file).
3. Add a short `README.md` note about MoE mode (optional).

### Acceptance criteria

- `AGENTS.md` accurately describes current MoE status.
- No stale references to "not yet implemented" if features are shipped.

### Files to change

- `AGENTS.md`
- `docs/specs/2025-07-30-agent-level-moe-plan.md`

---

## Suggested commit sequence

| Commit | Scope | Files |
|--------|-------|-------|
| `feat: add tool tags and filter by expert tags` | Phase 0 | `src/tools/*`, `tests/tools/*` |
| `feat: add expert registry to config` | Phase 1 | `src/config/*`, `tests/config/*` |
| `feat: enforce subagent file scope` | Phase 2 | `src/tools/*`, `tests/tools/*` |
| `feat: add MoE plan validation` | Phase 3 | `src/modules/execution/*`, `tests/modules/execution/*` |
| `feat: add orchestrator plan/verify modes` | Phase 4 | `src/llm/*`, `tests/llm/*` |
| `feat: add MoE execution engine` | Phase 5-7 | `src/modules/execution/*`, `tests/modules/execution/*` |
| `feat: integrate MoE into agent loop` | Phase 8-9 | `src/core/*`, `src/config/defaults.ts` |
| `docs: update MoE status and implementation plan` | Phase 10 | `AGENTS.md`, `docs/specs/*` |

---

## Risk register

| Risk | Mitigation |
|------|-----------|
| Router generates invalid JSON plan | Use `jsonrepair` + fallback to single-agent loop. |
| Write-write overlap sneaks in | Strict pre-flight validator + unit tests. |
| Subagent ignores scope | Runtime guard in every file tool + tests. |
| Re-plan cycles exhausted | After 3 cycles, return partial result + clear explanation. |
| Prompt builder drops important tools | Test that every expert tag maps to at least the tools it needs. |

---

## Open follow-ups (post-MVP)

- Scope expansion via `scope_request`.
- Per-expert quantization (depends on provider support).
- Dynamic expert tag discovery by LLM.
- Cost/budget tracking per subtask.
