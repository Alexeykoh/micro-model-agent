# Parallel subagents in a tool batch — design

- **Date:** 2026-10-07
- **Status:** implemented
- **Branch:** `feat/parallel-subagents`
- **Type:** MINOR (new behavior + one additive `ToolDefinition` field)

## Context / motivation

The `subagent` tool advertises *"Use for parallel work or complex sub-tasks"*
(`src/tools/subagent.ts:35`). A live session (`ses_muxqw12h_6uk4cq`) proved this
is a lie: when the model emitted **two `subagent` calls in one assistant turn**,
they executed strictly one after another.

Evidence from `session.jsonl`:

| call | start | finish | duration |
| --- | --- | --- | --- |
| subagent #1 | 07:03:38.976 | 07:04:04.977 | 25 995 ms |
| subagent #2 | 07:04:04.978 | 07:04:34.124 | 29 143 ms |

The second call starts **1 ms after the first finished**; wall-time = sum, not
max. The model then reported *"parallel calls work correctly"* — a false claim
the harness made true-looking only by speed of speech.

Root cause: `ToolBatchExecutor.execute` (`src/core/agent/tool-batch.ts:219`)
runs the calls of one iteration in a plain sequential `for` loop:

```ts
for (const call of toolCalls) {
  ...
  result = await this.deps.toolExecutor.execute(call, ...); // line 240
}
```

There is no `Promise.all` anywhere in `src/core/agent`. The only real
parallelism lives in the MoE executor (`moe-executor.ts:496`) and inside
`pipeline_run` / `chunk_query`. In the affected session MoE was **off**
(`orchestrator.model` unset), so everything went through the serial plain loop.

## Goals

1. Make a batch of ≥2 `subagent` calls in the same assistant turn actually run
   concurrently (wall-time ≈ max, not sum).
2. Keep all shared-mutable state correct: no scope/recursion-depth races between
   sibling subagents, memo invalidation preserved, deterministic message order.
3. Be generic — the mechanism is a tool capability flag, not a hard-coded
   `subagent` special case.

## Non-goals

- Parallelizing arbitrary tools. Only tools explicitly marked `parallelizable`
  (today: `subagent`) are batched. Destructive/tool-hook-heavy tools stay serial.
- Parallelizing the tool-hook / context bookkeeping. Only the *handler* runs
  concurrently; every hook, UI event and `role:"tool"` message stays serial and
  ordered.
- Touching the MoE path (it already has its own wave scheduler).

## Design

### 1. Capability flag

`ToolDefinition.parallelizable?: boolean` (`src/tools/types.ts`). A tool opts in
when it is safe to run concurrently with siblings of the same batch and does not
depend on shared executor state. `subagentTool` sets it.

### 2. `ToolExecutor.fork()` — isolated per-call executor

`ToolExecutor` owns one mutable `ToolContext` (`scope`, `recursionDepth`,
`activeCallId`, `cleanup`) plus a memo. Concurrent `execute()` on one instance
races on all of those. So each parallel call gets its **own** executor:

```ts
fork(): ToolExecutor
```

- Clones the `ToolContext` **by property descriptors**, preserving live getters
  (`config`, `sessionId`, `sessionContext`, `sessionManager`, `capabilities`).
- Gives the clone its own `scope` / `recursionDepth` / `activeCallId` / `cleanup`.
- **Shares the memo `Map`** with the parent — so a mutation performed by a
  subagent still invalidates the parent's cached read-only results (no stale
  `read_file` after a sibling wrote the file).
- Shares `registry` and `pluginManager` (read-only / hook dispatch).
- Re-points `ctx.toolExecutor` at the fork, so a subagent's child agent runs its
  own tools on the isolated executor.

This is the same isolation pattern the web per-session runner already uses
(`session-runner-scope.ts`), applied per parallel call instead of per session.

### 3. Batched execution in `ToolBatchExecutor`

The loop is split into three closures (`prepareCall` / `executeCall` /
`finalizeCall`) so the existing single-call path and the new parallel path share
all bookkeeping.

A **parallel run** is a maximal sequence of ≥2 consecutive `parallelizable`
calls. Singleton eligible calls stay on the serial path (no benefit, no behavior
change).

For a parallel run:

1. `prepareCall` for each call, **serial, in order** — `setScope`, plugin
   `onToolCall` / `onToolStart`, UI `tool_start`, session log.
2. Execute handlers **concurrently**, each on `toolExecutor.fork()`, capped by
   `security.rateLimits.maxParallelTasks` (default 5). Each fork runs the normal
   `execute()` (allowlist, `onBeforeTool`, timeout, abort, `onAfterTool`).
3. `finalizeCall` for each call, **serial, in order** — `onToolEnd`, meta/diff
   rendering, `role:"tool"` message + image queue, cost/token deltas, `tool_end`,
   summaries, security/workaround nudges, failure counters, compaction.

Non-eligible and singleton calls use exactly the previous flow
(`prepareCall` → `execute` → `finalizeCall`).

### 4. Subagent isolation falls out for free

The `subagent` handler still mutates `ctx.toolExecutor.setScope` /
`setRecursionDepth` and saves/restores the parent scope. On a fork those writes
land on the fork's own context, so siblings can no longer clobber each other's
scope or recursion depth. No change to `subagent.ts` beyond the flag.

## Data flow (parallel run)

```
assistant(tool_calls: [subagent, subagent])
  │
  ├─ prepareCall(#1)  setScope → onToolCall → onToolStart → UI start → slog
  ├─ prepareCall(#2)  …
  │
  ├─ fork#1.execute(call#1) ─┐
  ├─ fork#2.execute(call#2) ─┴─ Promise.all (cap maxParallelTasks)
  │        each: allowlist → onBeforeTool → handler(Agent.run) → onAfterTool
  │
  ├─ finalizeCall(#1) → role:tool message, onToolEnd, meta, counters
  ├─ finalizeCall(#2) → role:tool message  (order preserved)
  │
system-summary → next LLM iteration
```

## Edge cases

- **Abort / shutdown during a run**: after `Promise.all`, if shutdown is
  requested, synthesize `[interrupted]` tool results for unanswered calls and
  return `{ interrupted: true }` — same contract as the serial path.
- **`onBeforeTool` block**: handled inside `fork.execute`, so a blocked subagent
  returns `blocked: true` exactly as serial; it never counts as a failure.
- **Timeout**: `fork.execute`'s `failFast` kills by `call.id` and runs the fork's
  `cleanup`; sibling forks are untouched.
- **Memo**: shared map → a write in one subagent invalidates the whole session's
  cacheable memo, matching the previous shared-executor behavior.
- **Cost/usage**: each tool's `ctxDelta`/`costUsd` is still computed serially in
  `finalizeCall` (tokens before/after the whole run for that call — deltas for
  concurrent calls overlap by design; documented as approximate at the per-call
  UI level).
- **Plugins with shared state** (execution stuck-detector, lint-on-write):
  sibling child agents' inner tool calls can hit the shared `pluginManager`
  concurrently. This pre-exists in the MoE path (shared executor across wave
  tasks); mutations are single-threaded and non-corrupting. Documented, not
  fixed here.

## Testing

- `tests/core/tool-batch-parallel.test.ts`:
  - two `subagent`-tagged calls overlap (both `started` before either resolves)
    and total wall-time < sum;
  - sibling forks do not see each other's scope/recursion-depth;
  - `role:"tool"` messages are appended in original call order;
  - non-parallelizable calls remain sequential;
  - `maxParallelTasks` caps concurrency.
- `tests/tools/executor-fork.test.ts`:
  - `fork()` isolates `scope`/`recursionDepth`/`cleanup`/`activeCallId`;
  - live getters (`config`, `sessionId`) stay live;
  - memo is shared (write in a fork clears the parent's cached read).
- Existing `subagent-tool.test.ts` continues to pass (handler unchanged).
- Existing `tool-batch-*` tests continue to pass (default serial path).

## Rollout

- No config migration; `security.rateLimits.maxParallelTasks` already exists and
  is surfaced in `/config` and web Settings.
- Behavior change is additive: only batches of ≥2 `subagent` calls change timing.
- Future parallelizable tools opt in by setting the flag.
