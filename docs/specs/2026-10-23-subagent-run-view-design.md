# Subagent run view in `mma web` — design

- **Date:** 2026-10-23
- **Status:** implemented (0.11.0)
- **Branch:** `feat/subagent-run-view`
- **Type:** MINOR (new behaviour + additive `ToolContext` field + additive SSE event)

## Context / motivation

`TODO.md §1.1` asks for a click-through into a subagent's work:

> клик по субагенту переключает вид чата на ход работы субагента с возможностью
> вернуться назад. Одновременно может работать много субагентов: переключение
> между ходами + возврат в родительский чат без потери состояния.

Today the web UI knows only the outer `subagent` tool call:

- `runSubagent` builds a fresh `Agent` and calls `subAgent.run(task)` **without**
  UI callbacks, so its text/tool/reasoning events never reach SSE
  (`src/tools/subagent-run.ts`).
- The sub-agent receives no `sessionManager`, so its internal steps are not
  written to `session.jsonl` either (`src/core/agent/turn-run.ts:70`).
- In the feed the user sees one `◇ Задача подагенту` row with a final output
  capped at 6000 chars; the Trace tab shows the same single row.

A sub-agent is not a session: it has its own `ContextManager`, but it shares the
parent `ToolExecutor`/`SessionLogger` handles. The fix must therefore add a
**run** identity and a run event stream, not a child session.

## Goals

1. Every `subagent` call gets a `runId`; its live events (text, reasoning, tool
   calls, final output) are streamed to `mma web`.
2. Clicking the `subagent` row switches the chat pane to that run's transcript;
   a toolbar chip list switches between concurrent runs; `← к чату` (and Esc)
   returns to the parent feed **without losing its scroll position or live
   updates**.
3. Works for nested subagents (each run is independent) and for parallel
   siblings from one batch.
4. Fail-open: the observer must never break a sub-agent run.

## Non-goals

- Child sessions in the session list. Runs are not sessions and are not restored
  by `/resume`.
- Persistence across server restart or page reload (in-memory per process).
- Terminal (`mma` REPL) parity — the CLI keeps rendering the tool row only.
- Writing sub-agent internals into `session.jsonl` (that would change the
  session transcript contract and duplicate the parent's own log).

## Contract changes

### 1. `ToolContext.subagentRuns` (additive)

```ts
/** Приёмник событий прогонов субагентов (веб-UI). Fail-open: ошибки глотаются. */
subagentRuns?: SubagentRunSink;
export interface SubagentRunSink {
  emit(event: SubagentRunEvent): void;
  /** Опционально: ручка остановки прогона (кнопка веба). */
  registerInterrupt?(runId: string, interrupt: () => void): void;
  releaseInterrupt?(runId: string): void;
}
```

Hosts that do not set it (CLI, service, tests) are unaffected.

### 1b. `ToolContext.abortSignal` (additive)

`ToolExecutor.execute` puts the current call's `AbortSignal` into the context
before invoking the handler. `runSubagent` subscribes to it and calls
`subAgent.shutdown()`, so stopping the parent turn also stops its subagents
(including nested ones, because each link carries its own signal).

### 2. `SubagentRunEvent` (new, `src/tools/subagent-runs.ts`)

Discriminated union, no user transport fields:

| `kind` | payload |
| --- | --- |
| `start` | `runId`, `parentSessionId`, `parentToolCallId?`, `depth`, `task`, `agent?`, `model?`, `at` |
| `text` | `runId`, `chunk` |
| `reasoning` | `runId`, `chunk` |
| `note` | `runId`, `chunk`, `metaKind?: "status" \| "tool"` (loop statuses; tool bodies stay on `tool_*`) |
| `phase` | `runId`, `phase: "thinking" \| "done"` |
| `tool_start` | `runId`, `callId`, `tool`, `args` |
| `tool_end` | `runId`, `callId`, `tool`, `success`, `durationMs?`, `output?` |
| `end` | `runId`, `status: "done" \| "failed" \| "interrupted"`, `iterations`, `durationMs`, `output?`, `error?`, `usage?` |

`runId` is `srun_<random hex>`; uniqueness is per process. `parentToolCallId` is
the executor's `activeCallId`, so the client can map the parent tool row to the
run without guessing.

### 3. `ToolEvent.callId?` (additive)

`Agent.run`'s `onTool` events carry no call id. Add optional `callId` filled from
`call.id` in `tool-batch.ts`; the subagent observer uses it directly. The main
web forwarder keeps its synthetic `tN` ids (no behaviour change).

### 4. SSE `subagent` event (additive)

Server broadcasts `{ type: "subagent", ts, sessionId, ...event, seq }` where `seq`
is a per-run monotonic counter assigned by the server. The client routes by
`sessionId`, merges by `seq`, and ignores unknown event kinds.

### 5. `GET /api/sessions/:id/subagents` (new)
- `200 { runs: RunSnapshot[] }` — runs of that session, newest last.
- `?toolCallId=<id>` — filter used when a row is clicked before the live map is
  filled.
- `404` for a foreign/unknown session; `503` without a session manager.
- Same auth/same-origin as every other API route.

### 5b. `POST /api/sessions/:id/subagents/:runId/interrupt` (new)

Stops one run: `200 {ok:true}`, `404` for an unknown/foreign session or run,
`409 {error:"not_running"}` when the run already finished. The run closes with
`end.status = "interrupted"` through the normal event stream.

`RunSnapshot` = metadata (`runId`, `parentToolCallId`, `task`, `agent`, `model`,
`startedAt`, `endedAt`, `status`, `output?`, `error?`, `iterations?`) plus the
stored `events[]` (already scrubbed and capped).

## Core flow

In `runSubagent` (after `runId`/`sink` are ready):

```ts
emit({ kind: "start", ... });
const result = await subAgent.run(
  fullTask,
  (chunk) => emit({ kind: "text", chunk }),
  (meta, kind) => emit({ kind: "note", text: meta, kind }),
  (ev) => emit(ev.type === "start"
    ? { kind: "tool_start", callId: ev.callId ?? …, tool: ev.tool, args: ev.args }
    : { kind: "tool_end", … }),
  (phase) => emit({ kind: "phase", phase }),
  (chunk) => emit({ kind: "reasoning", chunk }),
);
emit({ kind: "end", status, … });
```

`emit` wraps `sink.emit` in `try/catch` — a broken observer never affects the
result. `end` is emitted from `finally` (exactly once) so a timeout/abort still
closes the run.

## Server store (`src/modules/webui/session/subagent-runs.ts`)

- `SubagentRunStore` owns `Map<runId, StoredRun>` and a per-session ordered list.
- Ingests each event: scrubs text with `sanitizeOutputPlain` +
  `redactContextSecrets`, args with `scrubToolArgs`, clips tool output to 4000
  chars, coalesces text/reasoning every 50 ms (timer `unref`), assigns `seq`, and
  broadcasts the wire event.
- Caps: 1000 events/run, 120k chars of stored text/run, 12 retained runs/session
  (oldest **finished** run evicted first; a running run is never evicted).
- `forgetSession(id)` on session delete.
- Wired in `runRunnerTurn`: `runner.toolCtx.subagentRuns = { emit(ev) => store.ingest(ev, s) }`.
  Forks copy the field, so nested subagents reach the same sink.

## Web UI

- `onToolStart` marks `subagent` rows with `data-tool-call-id`; when a `subagent`
  `start` event arrives, the matching row gets `data-run-id` + `.srun-link`
  (clickable). Clicking is delegated from `#msgs`, so live-created rows work.
- Opening a run:
  1. remember `msgs.scrollTop` of the parent feed;
  2. build `.srun` (top bar: `← к чату`, task, status/duration; chip row with all
     session runs; transcript body);
  3. `msgs.replaceChildren(.srun)` — the parent `tab.feed` is **detached but
     live**, so SSE keeps updating it;
  4. fetch the snapshot, render events by `seq`, then apply any newer live events
     from the client buffer (dedupe by `seq`).
- Rendering: text via `mountMarkdown` (streaming, escaped), reasoning via the
  existing collapsible think block, tools as `◇ <label> · args ✓/✗ duration` with  the output body (quiet default hides successful bodies, failures show the
  first line — same canon as the main feed), `end` as a metric/warn line.
- While the view is open: composer and rail are hidden (sub-agents cannot be
  prompted), `Escape` closes, and parent-feed appends must not scroll the view
  (`activeFeed()` guard). The header (back link, mascot, status, stop button,
  chips) lives in a sticky `.srun-head`, so switching or leaving stays one click
  away at any scroll position.
- The header's `■` button calls the per-run interrupt route; a run that is
  stopping stays disabled until its `end` event hides the button.
- Switching tabs/closing the tab closes the view and restores that tab's feed.

### MMART per run

Every run owns an MMART instance (`createFace` from `assets/js/loader.ts`):
the parent `subagent` row shows an `sm` face instead of the generic `◇` glyph,
the run header shows a 30 px face, and the top-right grid shows one cell per
known run of the active session. All three are driven by the run's own buffer
(`runFaceState`: `think` while waiting, `type` on text, `toolState(name)` on tool
start, `warn` on a failed tool, `done`/`error`/`stop` at `end`). The grid is
mounted on the chat surface, so it is visible both on the parent screen and in
the run view; it includes runs seeded from `GET /api/sessions/:id/subagents`
after a reload (newest 9), keeps finished runs, and clicking a cell opens that
run. The grid has exactly as many columns as cells (up to 3), so two mascots make
a two-cell capsule rather than leaving an empty slot. Historical rows are linked
to their runs in the `afterHistory` hook (`linkSubagentRows`), so they show the
same MMART and stay clickable after a reload. Face states are decorative (`aria-hidden`, set by `createFace`), so the
grid button carries the task as its `aria-label`.

## Security

- Same-session only: the REST handler rejects runs whose `parentSessionId`
  differs; SSE still carries `sessionId` like every other event.
- All inbound text goes through the existing redaction/ANSI strippers on the
  server; the client uses `textContent`/streaming Markdown only (no HTML sinks).
- Caps above bound memory and payload size; `GET` is capped by the same body
  limits as other JSON routes.

## Acceptance / tests

1. `tests/tools/subagent-runs-events.test.ts` — start/text/tool/end order, runId
   and parent ids, unique ids for parallel runs, `end` on failure/timeout, sink
   throw does not change the tool result.
2. `tests/webui-subagent-runs-store.test.ts` — seq, scrubbing, caps, eviction,
   `forgetSession`, `?toolCallId` filtering.
3. `tests/webui-subagent-view-dom.test.ts` — row becomes clickable on `start`,
   click opens the view, live `text` appends, parent feed keeps receiving events
   while detached, back restores the same feed node, Esc closes.
4. Live run (`mma web` from the worktree, small model, one subagent) with a
   screenshot/manual check of click → transcript → back.
5. `bun test` + `bun run quality` green.

## Implementation notes

- The main web forwarder now uses `ToolEvent.callId` when present, so the
  parent row's `data-tool-call-id` matches `parentToolCallId` from the subagent
  `start` event. Synthetic `tN` ids remain the fallback for callers that do not
  provide one.
- State/usage extraction (`activeUsage`) moved to
  `src/modules/webui/session/usage-cache.ts` and the subagent buffers to
  `assets/js/feed/subagent-buffer.ts` to keep both `state.ts` (ceiling) and the
  view file under the rule-6 limit.
- Live verification (deepseek-v4.1-flash via `opencode-go`, sandbox workspace):
  the row became clickable on `start`, the view streamed `thinking → write_file ✓
  → read_file ✓ → markdown answer → ⟡ 3 iterations · 6.8s · 23153 tok`, the
  status settled to «завершён», `← к чату` restored the same feed (row `✓ 6.8s`)
  with the composer back. A second run on LM Studio 9B also showed a blocked
  `bash` tool and its `↳` cause in the view.

