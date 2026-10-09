# Read-only guard: duplicate predicate + graceful finalize — design

Date: 2026-10-09
Status: proposed (branch `fix/readonly-guard-finalize`)

## Problem

Session `ses_mv0pirf5_hnmbxj` (`qwen3.8-9b-distill`, `mma web`, mma 2.36.0) — a purely
read-only task ("проанализируй настройки в webui… скажи что готово, а что WIP"). The model
gathered the full evidence set by ~iteration 20 and was assembling its answer; the turn was
killed at iteration 24 with no final text:

```
"Read-only loop hard-stopped after 12 consecutive read-only batches"
```

Three defects, in order of impact:

1. **The guard conflates "no mutation" with "no progress".** `isNonProgressBatch`
   (`src/core/agent/tool-batch.ts:42`) marks a batch non-progress if every call is not a work
   mutation (`isWorkMutation`) and not `subagent`. A genuinely read-only task never mutates
   anything, so the streak always climbs and `HARD_STOP_READONLY_BATCHES` (12,
   `src/core/agent/constants.ts:77`) fires on a healthy analysis. The model was exploring
   *new* files and *new* grep patterns — real work — not repeating itself.
2. **The web never shows why.** `session/run-agent.ts:155-160` forwards only
   `success`/`interrupted`/`durationMs`/`toolCalls` into `turn_end`; `result.error` is dropped.
   `readonlyStopped` does not set `interrupted`, so `assets/js/feed/turn.ts:271-278` draws the
   generic `web.turn.failed` — the user is left guessing. (The terminal does print it:
   `cli/repl.ts:913`.)
3. **`grep` with `|` fails on Windows** and burned many iterations. `rg` is installed as an
   npm `.cmd`/`.ps1` shim; under Bun `spawn("rg", args)` runs the shim through `cmd.exe`, so
   `|` in the pattern becomes a pipe. Reproduced:

   ```
   > bun -e "execFileSync('rg',['-n','foo|bar','src/tools/grep-tool.ts'])"
   'bar' is not recognized as an internal or external command
   ```

   Every alternation pattern in the session failed (`PANEL_SECTIONS|panel:`,
   `isolatePlugins|…`, …). Because the external engine exits non-zero (not ENOENT), the JS
   fallback is never reached (`classifySearchError`, `src/tools/grep-tool.ts:66-74`).

## Goals

- A read-only task is never killed for the crime of not mutating. The turn always ends with
  the model's best final answer.
- Genuine repetition (the same tool call, literally, over and over) is still caught.
- When the harness stops the turn, the chat says why — on every surface.

## Non-goals

- **No intent classifier.** Keyword heuristics over the user message are brittle; once
  "progress" means "new action", they are unnecessary.
- **No new `research` tool.** It does not address the guard (N research calls hit the same
  ceiling) and duplicates `subagent` + existing read tools at a per-turn schema-token cost.
- **No change to MoE orchestration semantics.** Subtasks run through the same single-agent
  loop, so they inherit the fix; nothing MoE-specific changes.
- **No threshold changes** to the failed-batch honest-stop (4/6). Only its terminal changes.

## Design

### 1. Progress = an action not seen before (not "a mutation happened")

A batch is **non-progress** iff *every* call in it is an exact duplicate of a call already
made earlier in this turn. Any call whose `(tool, canonical-args)` is new makes the batch
progress.

- New helper `canonicalArgsKey(args)`: recursively sorts object keys and normalizes path
  separators, so a reordered-parameter call is still recognized as the same call. No such
  helper exists today — `stuck-detector.ts:272` and `session-logger.ts:177` use raw
  `JSON.stringify(args)`. Reuse the helper in `stuck-detector.ts`.
- Scope is the **whole turn**, not a 10-call window: re-reading a file 30 calls later is
  still redundant. `LoopState` gains `seenToolCalls: Set<string>` (bounded by
  `maxToolIterations`).
- Work mutations are naturally novel, so the old `isWorkMutation` special-case drops out of
  this path; an *identical* rewrite repeats → genuine loop (already covered separately by
  file-rewrite detection).
- Accounting tools need no special exclusion: varied `plan`/`todo` updates are progress
  (normal work), identical updates are duplicates (caught). This removes the need for any
  evidence/accounting table.
- Keep the two-tier shape: soft directive at 8, hard terminal at 12. The directive now fires
  only on real repetition, so a legitimately broad exploration never sees it.
- `process_log` polling is a legitimate identical repeat. Keep its existing "use
  `process_wait`" nudge; the duplicate streak must not send a pure poll loop straight to the
  terminal without that hint.

Rename for honesty: `consecutiveReadOnlyBatches` → `consecutiveDuplicateBatches`,
`readonlyNudged`/`readonlyStopped` → `duplicateNudged`/`duplicateStopped`,
`MAX_READONLY_BATCHES`/`HARD_STOP_READONLY_BATCHES` →
`MAX_DUPLICATE_BATCHES`/`HARD_STOP_DUPLICATE_BATCHES`, predicates `isNonProgressBatch` →
`isDuplicateBatch`. Internal only.

### 2. Graceful finalize instead of abort

When a terminal fires, do not return `interrupted: true`. Instead run one **tool-less** model
call and take the text as the final answer:

- Inject a `<system-summary>` directive ("tools are now disabled; write your final answer
  from what you have gathered; do not request tools").
- One `llmProvider.chat(history, [], signal, opts)` (`src/core/agent.ts:1056` shows the
  call shape); stream chunks through `onChunk`; set `state.lastText` and
  `state.finalAnswerAccepted = true`; break the loop.
- **Skip critic / audit / claim gates** for this call. The whole reason we stopped is that
  the result could not be verified with tools; a gate that retries into the model would
  defeat the exit.
- `AgentResult.success = true` when the forced text is non-empty; otherwise fall back to the
  existing failure. A machine-readable `stopReason` (`"duplicate"` | `"failed_batches"` |
  `"max_iters"`) records the trigger.

One shared helper `finalizeWithoutTools(state, reason)` covers all three terminals:

1. duplicate hard-stop (`tool-batch.ts`),
2. failed-batch honest-stop (`tool-batch.ts:662-668`),
3. **max-iterations exhaustion** — currently `agent.ts:1526` returns
   `error.max_iters` with whatever `lastText` happens to hold (often empty). Force the
   final answer there too, and only report `max_iters` if the forced call produced nothing.

MoE subtasks inherit this (same loop).

### 3. Stop reason in the chat

- `TurnEndSummary` (`session/forward.ts:83`) gains `stopReason?: string` and `error?: string`
  (both optional; partial summaries stay valid).
- `session/run-agent.ts:155` passes `result.error` / `result.stopReason`.
- SSE `turn_end` carries them; `assets/js/feed/turn.ts:271-278` renders the actual message
  instead of the generic `web.turn.failed`, keeping the generic line as fallback when absent.
- REPL already prints `result.error` (`cli/repl.ts:913`) — verify it is not printed twice
  (line 909 also emits `result.text || result.error`).
- i18n: existing keys `error.readonly_loop_stopped` / `error.retry_loop_stopped` /
  `error.max_iters` are reused; `error.readonly_loop_stopped` wording is updated to match the
  duplicate semantics (en+ru). New key for the "answer produced without tool verification"
  banner (en+ru).

### 4. `grep` alternation fix

In `src/tools/grep-tool.ts`: when an external engine fails with a **non-ENOENT** error whose
message looks like a shell/spawn failure (`is not recognized`, `not found`, `not operable`),
treat the engine as unavailable (`null`) and fall through to the next engine / JS fallback,
instead of returning `success: false` via `classifySearchError`. A genuine timeout still
errors. Additionally prefer a real `rg.exe` over the `.cmd`/`.ps1` shim when resolving the
binary.

### 5. Cleanup

Share `canonicalArgsKey` with `stuck-detector.ts` (drop its raw `JSON.stringify`). Full
unification of the duplicate streak with `hasRepetitiveToolCalls` is out of scope.

## Validation (dry-run on the failing session)

Replayed the `ses_mv0pirf5_hnmbxj` trace against the new predicate. Each of the 24
iterations made 1–2 calls, all with **distinct** arguments (different files, different grep
patterns), and no batch consisted solely of duplicates:

- **New predicate:** the duplicate streak stays at **0** for the whole turn — no directive,
  no terminal. The session runs to its natural answer.
- **Old predicate (matches the log):** every non-mutating batch fed the streak; the 8th
  emitted `exec.readonly_directive`, then `bash{git rev-parse…}` at iteration 12 reset it,
  and iterations 13–24 (12 consecutive) hit `HARD_STOP_READONLY_BATCHES` — exactly the
  `Read-only loop hard-stopped` line at 08:39:03.
- **Honest-stop never fired:** `consecutiveFailedBatches` counts only *fully* failed
  batches, and each failing `grep` shared its batch with a successful call. Under the grep
  fix these failures disappear entirely.
- **Grep fix:** a `|` pattern that the broken `rg.cmd` shim rejects is marked engine-
  unavailable and resolved by the JS `RegExp` fallback.

A constructed repeat case (read the same file at the same offset 13× — the first call
is new, so the streak reaches 12 on the 13th) confirms the terminal now yields an answer
plus a visible reason instead of an empty abort.

## Alternatives rejected

- **Intent classifier** (read-only by keywords) — brittle across languages/tasks, and
  redundant once progress is defined as novelty.
- **New `research` tool** — a nested search tool still needs the parent to write the answer
  and still climbs a "no new action" budget if called repeatedly; it duplicates capability.
- **Delete the read-only guard entirely** — loses the two-tier soft nudge and forces
  re-wiring repetition detection into the terminal.
- **"Similar action" heuristic** (same file / same pattern) — would cut legitimate research:
  the failing session's greps were all *distinct* patterns, which is exploration, not a loop.
- **Keep the abort but only add the reason** — surfaces the symptom without fixing it; the
  answer is still lost.

## Tests

- `tests/core/` — `canonicalArgsKey` (key order, path normalization); duplicate predicate
  (varied reads = progress, identical re-read = non-progress); directive at 8 / terminal at
  12 (adapted from `tests/core/tool-batch-honest-stop.test.ts`).
- `tests/core/` — `finalizeWithoutTools` on duplicate stop, failed-batch stop, and
  max-iterations exhaustion: one tool-less call, gates skipped, `success` semantics,
  `stopReason` set, empty answer falls back to failure.
- web — `turn_end` carries `stopReason`/`error` (`tests/webui-*`) and the feed renders the
  reason rather than `web.turn.failed`.
- `tests/tools/` — grep with a `|` pattern returns matches via the fallback despite the
  external engine failing.
- REPL — no double print of the error (adjust `tests/cli/` if needed).

## Compatibility

- Internal field/constant renames only; no config, SSE-contract, `session.jsonl`, or plugin
  API changes.
- `error.readonly_loop_stopped` key kept (wording adjusted) to avoid churn in i18n/tests.
- Existing stop-warning history in `app.jsonl` keeps its meaning; only the trigger predicate
  and the terminal behavior change.
