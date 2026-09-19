# Plan: Context Log (git-style context diff file)

**Status:** implemented
**Version target:** MINOR (1.2.0)
**Flag:** `--context-log`

## Goal

Record the **entire LLM context** (system prompt + tool definitions + message
history) into a single file per session, in a git-like diff format:

- snapshot 0 = the first full context (every line prefixed `+`, like a new file);
- every later snapshot = a line diff against the previous one (`-` removed, `+` added).

The model's **reasoning** is not part of the outgoing context, so it is written
in a separate, clearly-marked `[OUTPUT]` annotation that never participates in
the diff.

## Where it hooks

`Agent.executeSingleAgentLoop` (`src/core/agent.ts`) already builds a
`PromptSnapshot` per iteration (`buildPromptSnapshot(history, allToolsForBudget)`
at the prefix-monitor call). The logger is fed from that exact point:

- `record(messages, tools, meta)` — before the LLM call, diffs the outgoing context.
- `recordOutput({ reasoning, text, toolCalls })` — after the stream ends, writes
  the previous iteration's output as an annotation.

## File location

Always next to the session files, enabled by the flag:

```
~/.mma/sessions/<sessionId>/context.diff
```

Append across runs: an existing file gets a `run <pid> · <timestamp>` separator,
and each run restarts with a full snapshot 0 (self-contained diff chain).

## Format

See `docs`/chat example. Sections within the serialized context:
`[SYSTEM]`, `[TOOLS]`, `[HISTORY]`. Diff hunks are plain unified diff
(`---` / `+++` / `@@ -a,b +c,d @@`), no ANSI, no truncation of the file itself.

`[OUTPUT]` annotations are prefixed with `▍` and are NOT included in the diff.

## Module

`src/core/agent/context-log.ts`:

- `serializeContextForLog(messages, tools): string` — stable, multi-line canonical text.
- `unifiedDiff(prev, next, ctx, fromLabel, toLabel): string` — plain line diff
  with common prefix/suffix reduction + LCS (capped; falls back to full
  replacement for pathological inputs).
- `class ContextLogger` — header / run separator / snapshot counter (parsed from
  the existing file), `record`, `recordOutput`, `close` (no-op; append-only).

Secrets are redacted with a dedicated conservative pattern set
(`redactContextSecrets`) targeting recognizable tokens only, unless `redact: false`.
The generic `sanitizeLogMessage` is intentionally not used (its 30+ char generic
pattern corrupts legitimate context text like skill names).

## Wiring

1. `src/cli/commands.ts` — add `.option("--context-log", t("cli.context_log"))`.
2. `src/cli/main.ts` — read `opts.contextLog`, pass to both `bootstrap()` calls.
3. `src/core/bootstrap.ts` — new param `contextLog?: boolean`; build the
   `ContextLogger` when enabled (after the active session exists); add to `AgentDeps`.
4. `src/core/agent.ts` — `AgentDeps.contextLogger?`; record in the loop; output after the stream.
5. `src/config/types.ts` + `defaults.ts` + `domains.ts` + `config.ts` — optional
   `contextLog: { enabled, redact }` config + `MMA_CONTEXT_LOG` env.
6. i18n `cli.context_log` (en/ru).
7. Tests `tests/context-log.test.ts`.

## Non-goals

- No MoE-path logging (single-agent loop only).
- No REPL command to toggle at runtime (flag/env/config only).
- `src/ui/diff.ts` is NOT reused: it is ANSI-colored and truncates at 100 lines,
  unsuitable for a persistent log.
