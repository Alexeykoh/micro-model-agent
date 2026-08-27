# Execution & Agent Loop

## Execution Guarantees

### Plan Enforcement

- `autoPlan: true` adds a strong system prompt directive to create a plan for any multi-step task
- The plan is always visible in the system prompt as a checklist `[x]` / `[ ]`
- The execution module warns the model when a tool call targets files outside the current step
- After `write_file` / `edit_file`, the execution module auto-advances the plan if all files mentioned in the current step exist

### Plan Management (Multi-Plan)

Plans are stored in `<project>/.mma/plans/` with automatic history management:

```
.mma/plans/
├── active.json          # current active plan
├── drafts/              # preserved incomplete plans
│   └── <plan-id>.json
└── archive/             # completed or aborted plans
    └── <plan-id>.json
```

**Source:** `src/modules/execution/plan-store.ts` (`PlanStore`)

**Plan tool actions:**

| Action    | Description                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------- |
| `create`  | Start a new plan. Previous active plan is auto-preserved: incomplete → draft, complete → archive. |
| `update`  | Mark step status (done/failed/skipped).                                                           |
| `show`    | Print current plan checklist.                                                                     |
| `abort`   | Archive current plan and clear active slot.                                                       |
| `list`    | Show all plans (active, drafts, archived) with progress.                                          |
| `switch`  | Make a different plan active by plan id.                                                          |
| `re-plan` | Iterative replanning: keep completed steps, replace remaining with new steps.                     |

**Key behaviors:**

- Creating a new plan never destroys an existing active plan — it's automatically preserved as draft or archive
- `re-plan` keeps all done/skipped steps and appends new pending steps with sequential ids
- Legacy `.mma/plan.json` is automatically migrated to `.mma/plans/active.json` on first load
- The `Plan` interface supports optional `name` field for named plans

### Stuck Detection

- `stuckThreshold` (default 6) — too many iterations on the same step injects a recovery message
- `tool repetition` — 3 identical tool calls with the same arguments inject a recovery message
- `off-track` — tool calls touching files not in the current step trigger a warning

### Auto-Verification

- Builtin `lint-on-write` plugin runs after every `write_file` / `edit_file`
- TypeScript files: per-file `tsc --noEmit --skipLibCheck` + project-wide `tsc --noEmit --skipLibCheck` when `tsconfig.json` exists (debounced at 2s)
- JavaScript files: `node --check`
- Syntax errors are appended to the tool result so the model can fix them immediately
- **Final Audit**: Before declaring task complete, the Auditor checks plan completion (all steps done, no missing files) and runs project-wide typecheck. If incomplete, a warning is injected into context and the agent continues working.

### Final Audit Gate

- Triggered when the model returns a final answer (no tool calls) and a plan is active
- Runs `Auditor.audit(plan)` which checks: file existence from step descriptions + project-wide `tsc --noEmit --skipLibCheck`
- If audit fails (`passed: false`), injects `<system-summary>` warning with pending steps and typecheck errors
- Agent continues the loop instead of breaking — bounded by `maxToolIterations`
- Session log records audit events with type `"audit"`

## Agent Loop States

```
INIT    → collect system prompt blocks → build context
THINK   → call LLM → validate response (hallucination check)
ACT     → parse tool_call → execute via ToolExecutor
OBSERVE → process results → check termination → loop or done
OUTPUT  → show text to user → wait for input
ERROR   → retry or escalate
```

## Orchestrator (optional)

If `orchestrator.model` configured: larger model handles planning, conflict resolution, audit. Worker (9B) executes steps. If not set — everything runs on one model.

## RLM-Inspired Features (pass-by-reference + chunked queries)

> **Spec:** `docs/specs/2026-08-12-rlm-inspired-design.md` — ports Recursive Language Models (arXiv:2512.24601) mechanics: sub-agent results by reference, and programmatic chunked processing of oversized inputs.

**Status:** implemented (all 9 tasks).

### Pass-by-reference sub-agent results

- `ArtifactStore` (`src/modules/artifacts/store.ts`): persists sub-agent results to `.mma/artifacts/<session>/`. `sanitizeName()` neutralizes traversal (`../../etc/passwd` → `etc_passwd`), `read()` returns `null` outside the root, `summary()` truncates with a marker.
- `subagent` tool accepts `result_mode: "file"` (+ `artifact_name`): the child's full answer is saved to an artifact and the parent receives a bounded path + summary instead of raw text — kills context-rot/transmission errors for a 9B model.
- Config: `subagent.resultMode` (`"text"` default, backward compatible), `maxSummaryChars`, `artifactsDir`, `stableSystemPrompt`, `maxParallelChunkQueries` (`src/config/types.ts` `SubagentConfig`).
- MoE executor (`moe-executor.ts`): when `resultMode: "file"`, subtask args get `result_mode`/`artifact_name = subtask.id`, and the Router's `SubtaskResult.result` carries the full artifact content (bounded summary only in the parent's context).
- Stable system prompt: `SUBAGENT_SYSTEM_PROMPT_TEMPLATE` (`src/tools/subagent.ts`) is byte-identical across calls (KV-cache friendly); variable context goes into the user message, not the system prompt. Few-shot workflow block (write large outputs to files, verify, delegate) is included.

### Chunked parallel queries (`chunk_query`)

- `runChunkQuery()` + `splitTextIntoChunks()` (`src/modules/context/chunk-query.ts`): RLM-style `llm_query` semantics — plain LLM calls (no tool loop) per newline-aware chunk with a bounded-concurrency pool and an optional synthesis pass.
- `chunk_query` tool (`src/tools/chunk-query.ts`): scope-checked `input_path` or inline `text`, params `chunk_chars`, `max_parallel`, `synthesize`, `max_chunk_tokens` (default 1024 — must fit reasoning + answer), `max_synthesis_tokens` (2048).
- `timeoutMs` on `ToolDefinition` overrides the 60s executor timeout per tool (chunk_query uses 300s — multiple LLM calls on slow providers).
- `LLMProvider.chat(messages, tools?, signal?, options?)` gained `ChatOptions.maxTokens` to cap generation per call.

## Hallucination Detection Pipeline

```
LLM response → ConfidenceCheck (short/repetitive)
             → FactualCheck (paths vs known set)
             → ConsistencyCheck (decision reversal)
```

Results: `pass` → show | `warn` → show with ⚠️ | `retry` → re-call LLM | `block` (3+ retries) → ask user

## Migration Safety

MMA v2 auto-detects v1 config on first load. If `~/.mma/config.json` lacks `version: "2.0.0"` or has v1-only fields (`apiBase`, `temperature`):

1. Backs up `config.json` → `config.json.bak`
2. Backs up entire `~/.mma/` → `~/.mma.bak/`
3. Starts fresh with v2 defaults
4. Old plugins/skills with incompatible format are skipped gracefully
