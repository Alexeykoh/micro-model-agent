# Model-Control Fixes Implementation Plan

> **For agentic workers:** implement task-by-task, TDD (test first), atomic commits `fix(scope): description`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the 15 findings of the 2026-08-26 agent audit — dead reasoning wiring, context bloat, invalid message sequences after compaction, double generation on thinking models, and loop-control bugs that report success as failure.

**Source:** audit conversation 2026-08-26 (ratings 3–5). Files: `src/core/agent.ts`, `src/llm/openai-compat.ts`, `src/modules/context/manager.ts`, `src/modules/hallucination/*`, `src/modules/reasoning/policy.ts`.

**Rules honored:** TDD (rule #7), i18n en+ru for any new user-facing string (rule #8), no keyword matching (rule #10), no file >300 lines where avoidable, single source of truth.

**Verification after every task:** `bun test <touched tests>`; at wave end `bun test` + `bunx tsc --noEmit`.

**Out of scope:** MoE limitations list, plugin system, certification suite changes.

---

## Wave 1 — Context integrity (criticals #1, #4, #13)

### Task 1: Truncate tool arguments in `<system-summary>` envelopes (#1, #13)

**Problem:** `agent.ts:953` embeds `JSON.stringify(call.arguments)` unbounded — a `write_file` with 10KB content is duplicated into the summary envelope on every call. Additionally each tool result appears twice in context (`role:"tool"` message + summary envelope).

**Files:**
- Modify: `src/core/agent.ts` (`executeSingleAgentLoop`, summaries push ~line 952)
- Test: `tests/core/agent.test.ts`

- [ ] **Step 1: Failing tests.** Run the agent loop with a stub provider returning a `write_file` whose `content` arg is 5KB. Assert the injected `<system-summary>` user message contains at most ~300 chars of the arguments and does NOT contain the full content body.
- [ ] **Step 2: Implement.**
  - Add helper in `agent.ts`: `summarizeToolArgs(args): string` — JSON.stringify, then truncate to **240 chars** with `…(N chars total)` marker.
  - Use it in `summaries.push(...)`.
  - Deduplicate (#13): drop fields already visible in the `role:"tool"` message — keep only `{name, short args, first 200 of output}` (this is what it already does, minus the unbounded args).
- [ ] **Step 3: Verify** budget math: run existing context-budget tests; confirm `getEstimatedTokens()` after one big write drops vs before the fix (assertion optional, manual check ok).

**Done when:** big-write scenario adds ≤400 chars per tool call to the envelope; all agent tests green.

### Task 2: Compaction never splits assistant(tool_calls)/tool pairs (#4)

**Problem:** `manager.ts:403-405` slices history at an arbitrary cutoff — can leave a `role:"tool"` message without its calling assistant (or vice versa) → invalid OpenAI sequence, 400s on strict backends.

**Files:**
- Modify: `src/modules/context/manager.ts` (`compact`)
- Test: `tests/context-manager.test.ts`

- [ ] **Step 1: Failing tests.**
  - Build a history where `cutoff = len - 12` lands between `assistant{tool_calls}` and its `tool` result. Assert: after `compact()`, the kept messages contain NO orphan tool messages (every `role:"tool"` is preceded by an assistant carrying a matching `tool_call_id`) and no assistant-with-tool_calls lacks its results.
  - Also assert a pair that starts inside `recentTurns` is pulled WHOLE into recent (moved forward), not compacted away.
- [ ] **Step 2: Implement.** After computing `cutoff`, walk it FORWARD while `recentTurns[0]` is a `role:"tool"` message or an assistant whose `tool_calls` reference tool results beyond the cut (pair-boundary alignment):
  ```ts
  while (cutoff < this.messages.length) {
    const m = this.messages[cutoff];
    if (m.role === "tool") { cutoff--; continue; }        // pull its assistant in
    break;
  }
  cutoff = Math.max(0, cutoff);
  ```
  Then verify the tail: if the LAST kept assistant has `tool_calls`, ensure its tool results are also kept (they always follow immediately, so forward-walk suffices — add a defensive filter that drops orphan assistants if any remain).
- [ ] **Step 3:** Keep `KEEP_LAST_N` semantics unchanged otherwise; update `CompactResult.keptTurns` accordingly.

**Done when:** property holds over randomized histories (loop 50 random histories incl. multi-call turns); existing compaction tests green.

---

## Wave 2 — Wire up reasoning control (criticals #2, #3)

### Task 3: Fix signal lifecycle so the policy actually sees events (#2)

**Problem:** per-iteration flags are reset at loop top (`agent.ts:532-536`) BEFORE `evaluateReasoningPolicy()` reads them (`:637`) — every raise signal is always false. `consecutiveSuccesses` / `isRepetitive` are hardcoded `0/false`.

**Files:**
- Modify: `src/core/agent.ts`
- Test: new `tests/core/reasoning-policy-integration.test.ts` + extend `tests/core/agent.test.ts`

- [ ] **Step 1: Failing tests.** Stub provider that (a) returns empty text once, then a final answer; config `reasoning.mode: "auto"`, `reasoningProbePassed: true`. Assert the second LLM call received `options.reasoningEffort === "high"` (the hallucination-retry raise). Currently it receives baseline → test fails.
- [ ] **Step 2: Implement.**
  - Move the reset of `iter*` flags to AFTER they are consumed: evaluate policy using last iteration's flags, then reset them at the END of the iteration (or reset immediately after the `evaluateReasoningPolicy` call — pick one, document with a comment).
  - Feed real signals:
    - `consecutiveSuccesses`: count consecutive successful file-mutating tool batches (already tracked via `consecutiveToolFailures`; derive successes from it, reset on failure/final answer).
    - `isRepetitive`: reuse StuckDetector's repetitive-tool-call verdict exposed by the execution module (add a getter if missing; do NOT do keyword matching — rule #10).
    - `planCreated`: set true in the branch handling a successful `plan` tool call with `action === "create"`/`re-plan` (check `call.name === "plan"` && parsed result success) — inside the tool-result loop, before `continue`.
- [ ] **Step 3:** Log stays truthful: `logReasoningControl` source must reflect what actually decided.

**Done when:** integration test shows level transitions low↔high across a scripted scenario (empty response → high; 2+ successful writes → low; plan create → high boost).

### Task 4: Make `set_thinking` / `/thinking` affect real requests (#3)

**Problem:** `Agent.reasoningState.level` is mutated by the tool and REPL but never read when building the chat request — the override is cosmetic.

**Files:**
- Modify: `src/core/agent.ts` (effective-level computation ~line 634-650)
- Modify: `src/tools/set-thinking.ts` (only if cooldown semantics need adjusting)
- Test: `tests/core/agent.test.ts`, `tests/set-thinking.test.ts`

- [ ] **Step 1: Failing tests.**
  - Config `reasoning.mode: "manual"`, user sets level via tool to `"none"` → next chat call carries `reasoningEffort: "none"`.
  - Override expiry: `set_thinking` with duration N — after N iterations calls revert to policy/config value (respect `overrideIteration` logic already in set-thinking.ts:53).
- [ ] **Step 2: Implement.** Precedence in the loop:
  ```ts
  const overrideActive = this.reasoningState.overrideIteration >= 0 &&
    iteration - this.reasoningState.overrideIteration < OVERRIDE_DURATION_ITERS;
  effectiveReasoningLevel = overrideActive ? this.reasoningState.level
    : mode === "auto" ? policyResult.level
    : mode; // manual/static
  ```
  Read `OVERRIDE_DURATION_ITERS` from what set-thinking already stores (align both sides — single source of truth constant exported from `set-thinking.ts`).
- [ ] **Step 3:** REPL `/thinking` path (`repl-commands.ts:263`) needs no change once state is honored; verify manually via log line `logReasoningControl.source === "agent_override"`.

**Done when:** override reaches the wire within its window and expires afterwards; all reasoning tests green.

---

## Wave 3 — LLM layer (findings #5, #6)

### Task 5: Count reasoning chunks in stream fallback decision (#5)

**Problem:** `chat()` falls back to non-streaming when `!hasToolCall && !hasText` — a thinking model that streamed ONLY `reasoning_content` triggers a full duplicate request (double tokens/time, duplicated reasoning output).

**Files:**
- Modify: `src/llm/openai-compat.ts` (`chat`, lines ~130-146)
- Test: `tests/openai-compat.test.ts`

- [ ] **Step 1: Failing test.** Mock fetch returning an SSE stream with only `delta.reasoning_content` chunks then `[DONE]`. Assert `doNonStreaming` is NOT called (spy) and yielded chunks contain exactly the reasoning deltas once.
- [ ] **Step 2: Implement.** Track `hasReasoning`; fallback condition becomes `!hasToolCall && !hasText && !hasReasoning`. Note: keep fallback for genuinely-empty streams (their documented Ollama case).
- [ ] **Step 3:** Confirm the 3 existing NDJSON/error-stream tests still pass.

**Done when:** reasoning-only streams don't re-request; empty streams still fall back.

### Task 6: Rate limiter waits instead of killing the turn (#6)

**Problem:** pre-request limiter throws plain Error → agent treats it as fatal LLM error → turn ends with `success:false`.

**Files:**
- Modify: `src/modules/security/rate-limiter.ts` (expose `msUntilRequest()`)
- Modify: `src/llm/openai-compat.ts` (`chat` entry)
- Test: `tests/rate-limiter.test.ts`, `tests/openai-compat.test.ts`

- [ ] **Step 1: Failing test.** Limiter exhausted; `chat()` resolves successfully AFTER waiting (fake timers), rather than throwing.
- [ ] **Step 2: Implement.** Replace throw with bounded await: `const wait = limiter.msUntilRequest(); if (wait > 0) await sleep(min(wait, MAX_RATE_WAIT_MS=30_000), signal)` then retry the check once; if still blocked, throw with `err.recoverableLlm = true` so the agent feeds it back instead of dying. Respect AbortSignal during the wait.
- [ ] **Step 3:** i18n not needed (no new user-facing text; error already localized).

**Done when:** self-inflicted rate limit delays, never aborts a healthy turn.

---

## Wave 4 — Loop control logic (findings #7, #8, #11)

### Task 7: Fix repetition detector false positives (#7)

**Problem:** word-overlap >0.5 vs previous response retries legitimate short answers («Готово.» twice = 100%).

**Files:**
- Modify: `src/modules/hallucination/confidence.ts`
- Test: `tests/hallucination-confidence.test.ts` (or wherever ConfidenceCheck is tested)

- [ ] **Step 1: Failing tests.**
  - Two consecutive short answers «Готово.» / «Готово.» → `pass` (or `warn`, not `retry`).
  - Two long near-identical answers (>200 chars, overlap >0.7) → still `retry`.
  - Asymmetric overlap: short answer after long answer → not flagged (denominator asymmetry fix).
- [ ] **Step 2: Implement.**
  - Require BOTH responses ≥ MIN_REPEAT_CHARS (e.g. 120 chars) AND ≥ MIN_REPEAT_WORDS (e.g. 20) before repetition applies.
  - Make overlap symmetric: `intersection / min(|A|,|B|)` but only flag when the shorter side is substantive (per thresholds above).
  - Threshold: flag at overlap > 0.8 (was 0.5).
- [ ] **Step 3:** The `suppressRepetitionRetry` machinery stays (audit-gate path legitimately repeats) but should now almost never trigger — leave as safety net.

**Done when:** scripted short-answer sessions complete without hallucination retries; genuine loops still caught.

### Task 8: Success on the final iteration is reported as success (#8)

**Problem:** `agent.ts:1244` checks `iteration >= maxToolIterations` AFTER the loop — a final answer produced on iteration N=max returns `success:false` + max_iters error despite holding the finished text.

**Files:**
- Modify: `src/core/agent.ts` (result selection after loop)
- Test: `tests/core/agent.test.ts`

- [ ] **Step 1: Failing test.** `maxToolIterations: 2`; provider answers with tools on iter 1, final text on iter 2. Assert result `success === true`, `text === <final>`, no `error`.
- [ ] **Step 2: Implement.** Track why the loop ended: `let endedBy = "answer" | "max_iters" | "shutdown"`. Set `endedBy = "max_iters"` only when the while-condition itself fails AND the last iteration did NOT end with an accepted final answer (i.e., we didn't reach the `break` at the audit-gate/answer path). Simplest correct form: set a flag `finalAnswerAccepted = true` right before the terminal `break` (`:1231`) and gate the max-iters error on `!finalAnswerAccepted`.
- [ ] **Step 3:** Same treatment for `emptyResponseExhausted`/`auditFailed` paths — they already carry explicit flags; make sure precedence is `auditFailed > emptyResponseExhausted > max_iters`.

**Done when:** boundary test passes; no regression in existing max-iterations tests.

### Task 9: Unify empty-response handling (#11)

**Problem:** empty responses burn `hallucinationRetries` (via ConfidenceCheck `short`) while a parallel `emptyResponseRetries` guard below is nearly unreachable — two counters, inconsistent limits (3+2).

**Files:**
- Modify: `src/modules/hallucination/confidence.ts` (return distinct kind for empty)
- Modify: `src/core/agent.ts` (route by kind)
- Test: `tests/core/agent.test.ts`, confidence tests

- [ ] **Step 1: Failing tests.** Empty response consumes `emptyResponseRetries` (max 2) and does NOT increment `hallucinationRetries`; a SHORT-but-non-empty response still uses the hallucination path.
- [ ] **Step 2: Implement.**
  - `ConfidenceCheck.validate("")`: return `{status:"retry", kind:"short", reason: hall.empty_response}` — add i18n key `hall.empty_response` (en+ru).
  - In the retry branch of `agent.ts`: if `hallucinationResult.kind === "short" && !textContent?.trim()` → route into the existing empty-response block (move that block ABOVE the hallucination handling or extract a shared `handleEmptyResponse()`); else → hallucination retry.
  - Remove the now-dead duplication; keep one nudge message format (i18n'd, en+ru).
- [ ] **Step 3:** Delete dead branch remnants; grep for `MAX_EMPTY_RESPONSE_RETRIES` to confirm single consumer.

**Done when:** exactly one counter governs empty responses; limits documented in code comment.

---

## Wave 5 — Judge & prompt stability (findings #9, #10)

### Task 10: Gate LLM-judge behind capability + kill keyword decision extraction (#9)

**Problem:** judge runs on the same weak model (up to 15s per final answer); decisions extracted via regex `(?:plan|decided|решено...)` violates rule #10 and barely works outside English.

**Files:**
- Modify: `src/core/agent.ts` (decision tracking block ~1166-1177)
- Modify: `src/modules/hallucination/detector.ts` / `llm-judge.ts` (config gating)
- Modify: `src/config/types.ts` + `defaults.ts` (new config flag)
- Test: `tests/hallucination-*` , `tests/config.test.ts`

- [ ] **Step 1: Failing tests.**
  - Config `hallucination.judge.enabled: false` (default for local/small models) → judge never called (spy).
  - Decision extraction: a Russian/English response WITHOUT the magic words produces no decisions (currently impossible to assert meaningfully — instead assert the new source).
- [ ] **Step 2: Implement.**
  - Remove the regex decision-pattern block entirely. Decisions now come from structured sources only: `plan create/update` tool results (step descriptions) and explicit user corrections — wire `ConsistencyCheck.trackDecision` calls into those two points (execution module already sees plan calls; add hook there).
  - New config `hallucination.judge: { enabled: boolean }`, default **false**; enable only when orchestrator provider configured (`orchestrator.model` present) — judge should use `getProviderFor(orchestrator)`, not the worker model. Pass judge provider via `HallucinationDetector` constructor at bootstrap.
- [ ] **Step 3:** Update AGENTS.md Hallucination section (one paragraph).

**Done when:** default config makes zero extra LLM calls per final answer; judge works only in orchestrator setups.

### Task 11: Stable system-prompt prefix for KV-cache (#10)

**Problem:** `refreshSystemPrompt()` rebuilds the prompt every iteration; dynamic blocks (plan checklist) mutate bytes → local backends lose prefix cache → dominant prefill cost on 32K windows.

**Files:**
- Modify: `src/core/agent.ts` (`refreshSystemPrompt`)
- Modify: `src/modules/execution/plan-tool.ts` or wherever the plan prompt block is produced
- Test: `tests/core/agent.test.ts`, `tests/execution-plan-*.test.ts`

- [ ] **Step 1: Failing test.** Across 3 iterations with a changing plan, the system message content is byte-identical (no mid-conversation mutation).
- [ ] **Step 2: Implement.**
  - Freeze the system prompt after the FIRST build per session (`refreshSystemPrompt` becomes a no-op unless `reconfigure()`/`clearContext()` happened).
  - Move mutable state out of the system prompt: the plan checklist already exists as a `plan` tool result + REPL rendering; append a compact `[Plan: N/M done, current: step K]` line to the post-tool `<system-summary>` envelope (Task 1's pipeline) instead of rewriting the prefix. This mirrors what compaction already does via `planSummaryProvider`.
- [ ] **Step 3:** Verify `updateSystemPrompt` is called at most once per session in logs; measure prefill improvement qualitatively (llama.cpp `timings` line, optional manual step).

**Done when:** system message immutable during a session; plan progress still visible to the model after every tool batch.

---

## Wave 6 — Medium fixes (findings #12, #14, #15)

### Task 12: FactualCheck rescan race + async-friendly scan (#12)

**Files:**
- Modify: `src/modules/hallucination/factual.ts`
- Test: `tests/hallucination-factual.test.ts`

- [ ] **Step 1: Failing tests.**
  - Cooldown path: index stale + file created elsewhere → second `bareNameExists` within cooldown consults EXISTING cache before returning false.
  - (Optional stretch) scan runs off the hot path via lazy rebuild on next tick — skip if event-loop impact proves negligible; document decision.
- [ ] **Step 2: Implement.** In `bareNameExists`, replace early `return false` with `return this.indexHas(name)` (current cache is better than nothing); only clear the cache when proceeding with a real rescan.

### Task 13: Single token-estimation source (#14)

**Files:**
- Modify: `src/core/agent.ts` (`toolOutputCharLimit`, `resolveUsageTokens`), `src/modules/context/manager.ts`
- Test: existing suites only

- [ ] Introduce one shared helper (e.g. `charsToTokens(chars)` ≈ `/4` when tiktoken absent) used everywhere; `truncateToolOutput` switches to comparing token estimates, not raw chars. No behavior change intended beyond consistency; adjust affected constants (`TOOL_RESULT_ABSOLUTE_MAX_CHARS` etc.) accordingly.

### Task 14: Provenance by provider entry label (#15)

**Files:**
- Modify: `src/core/agent.ts` (`callerProvenance`)
- Test: `tests/providers*.test.ts` extension

- [ ] Return active entry label when `providerManager`/entries exist (`provider.active` label), falling back to `type`. Cost breakdown and failover logs become distinguishable. Update `CostTracker.record` consumers (keys change from type→label; verify pricing tests).

---

## Release

- [ ] Full `bun test` + `bunx tsc --noEmit`
- [ ] Live smoke on qwen3.5-9B (LM Studio): multi-file task — watch session.jsonl for (a) no orphan tool messages, (b) stable system prompt, (c) reasoning control transitions, (d) no duplicated big write payloads.
- [ ] Record any new small-model observations in `docs/small-model-observations.md`
- [ ] Version bump: Tasks 4, 10 (config surface) → **MINOR**; rest PATCH. Suggest one release `0.56.0` after all waves.
- [ ] Update AGENTS.md: Hallucination section (judge gating), reasoning section (override precedence), Key Design Rules note about stable system prompt.

## Suggested commit sequence

1. `fix(agent): bound tool args in summaries (context bloat)`
2. `fix(context): align compaction cutoff to message-pair boundaries`
3. `fix(agent): feed real signals into reasoning policy`
4. `feat(agent): honor set_thinking overrides on the wire`
5. `fix(llm): no non-streaming fallback for reasoning-only streams`
6. `fix(llm): rate limiter waits instead of failing the turn`
7. `fix(hallucination): repetition check requires substantive responses`
8. `fix(agent): accept final answer produced on the last iteration`
9. `refactor(agent): single empty-response handler`
10. `feat(hallucination): opt-in LLM judge on orchestrator, structured decisions`
11. `perf(agent): immutable system prompt per session (KV-cache friendly)`
12. `fix(hallucination): factual rescan consults warm cache`
13. `refactor(llm): unified token estimation helpers`
14. `fix(pricing): provenance by provider entry label`
