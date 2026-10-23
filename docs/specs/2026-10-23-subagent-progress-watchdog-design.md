# Subagent progress watchdog and cancellable timeouts — design

- **Date:** 2026-10-23
- **Status:** implemented
- **Branch:** `feat/subagent-progress-watchdog`
- **Type:** MINOR (new config key + timeout semantics + real cancellation)

## Problem

`subagent` had one wall-clock limit (`subagent.timeoutMs`, default 180 s) enforced
by `ToolExecutor`: a slow-but-productive 9B run (write → read → verify) was cut
off mid-task with a generic “tool timed out”. Worse, `failFast` only restored the
parent scope; the child `Agent` kept running after the parent already reported a
timeout, burning tokens and diverging from the run view (grid `done` vs row
“timeout”). 180 s also matches `retry.noDataTimeoutMs`, so both guards fired
together.

## Goals

1. Slow runs survive as long as they keep making observable progress.
2. A genuinely stuck run is stopped after an idle window.
3. A run cannot last forever: hard upper bound.
4. Any timeout (idle, max, executor backstop) **cancels the child agent**, not
   just its scope.
5. Parent and UI receive an actionable reason, and the run closes exactly once.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `subagent.timeoutMs` | `180000` | **Idle** timeout: no events for this long → stop. Key kept for compatibility; meaning changes from wall-clock to idle. |
| `subagent.maxDurationMs` | `1800000` | Hard cap for one run (30 min). |

Both are validated by the config registry (`10_000..1_800_000` for idle;
`60_000..7_200_000` for the cap). `subagentTool.timeoutMs` becomes
`maxDurationMs + 60 s` — the executor timeout is now only a backstop.

## Flow

`runSubagent` starts a watchdog (one `setInterval`, `unref`):

- every observer callback (`text`, `reasoning`, `note`, `phase`, `tool_start`,
  `tool_end`) calls `touch()` — the idle timer resets;
- `now - lastActivity >= idleMs` → `stopSubAgent()` (`subAgent.shutdown()`),
  `stopReason = "idle"`;
- `now - startedAt >= maxMs` → `stopSubAgent()`, `stopReason = "max"`;
- after `subAgent.run` resolves/rejects, if `stopReason` is set the tool result is
  `success:false` with the localized reason; `SubagentRunObserver.finish` emits
  `status:"failed"` and the same `error`, so the web row/grid show the cause;
- `finally` clears the interval, removes the parent-abort listener and releases
  the interrupt handle.

`ctx.cleanup` becomes `stopSubAgent() + restoreScope()`, so the executor's own
timeout also cancels the child (no orphan run). Compare-and-restore semantics
are preserved.

## Acceptance

- `tests/tools/subagent-runs-events.test.ts`:
  idle timeout stops a silent run with a clear error; max duration stops a
  chatty run; `ctx.cleanup()` calls `shutdown`; observer `end` is exactly once.
- `tests/config/*` / default registry: new key round-trips.
- Existing timeout cap test (`tests/tools/subagent-max-tokens.test.ts`) and
  subagent suite stay green.
- Live: a slow local run is no longer killed at 180 s while streaming; a stuck
  run returns “нет активности …” instead of the generic tool timeout.
