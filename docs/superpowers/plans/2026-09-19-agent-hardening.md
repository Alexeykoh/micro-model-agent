# Plan: Agent hardening from context-log analysis (1.3.0)

**Status:** implemented
**Branch:** `fix/agent-context-and-tools`
**Scope:** agent/harness fixes only — LM Studio configuration (B1) intentionally out of scope.

## Context

A real run (TDD landing page / tic-tac-toe, `qwen`-class local model) plus its
`context.diff` exposed loop bugs independent of language or task. All fixes are
generalized (token/структура/путь-based), not JS/TDD/task-specific.

## Fixes

1. **Budget-driven compaction** (`contextBudget.compactionMinLoad`, 0.5) — the
   15-iteration interval only fires when the history is meaningfully loaded.
2. **Context probe persistence** — written to the session in all modes and
   surfaced in one-shot runs.
3. **De-duplicated tool-arg summaries** — long values collapse to `…(N chars)`.
4. **Non-streaming fallback on buffered-SSE stall** after `tool_call` start.
5. **Interactive/workaround guards** — security-block hint points to tools;
   wrapper-script nudge (`.bat/.cmd/.sh/.ps1`) after a block.
6. **Test/spec churn detector** (`artifact-progress.ts`) — cross-language path
   classification, one advisory nudge.
7. **Plan integrity** — `plan update` rejects bulk `steps[]`/`title` rewrite.
8. **Stuck escalation to the model** — generic options injected as context.
9. **Artifact-requirement prompt rule** — requested documents are real files;
   no unlisted dependencies.

## Non-goals

- LM Studio loaded context / reasoning / parallel / SSE server settings.
- Any language- or framework-specific heuristics.
