# Research loop efficiency — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `mma-development`; implement task-by-task with TDD. Steps use `- [ ]` checkboxes.

**Goal:** устранить 6 причин 8-минутного research-прогона из сессии `ses_mwt1gw9o_eyxsehbrwjrhdzsn`.

**Architecture:** правки в статическом промпте, тулах (`mcp_call`, `chunk_query`, `grep`), tag-фильтре и существующем поле `progress` журнала. Новых модулей и ключей конфига нет.

**Tech Stack:** Bun, TypeScript, vitest/bun test, i18n en/ru, Biome.

---

### Task 1: early-exit в системном промпте

**Files:** Modify `src/core/system-prompt-render.ts:71-72`; Test `tests/core/system-prompt-early-exit.test.ts`

- [ ] Write a failing test: `buildSystemInfo()` содержит фразу про early-exit ровно 1 раз и не ломает `LIVE DATA`.
- [ ] Run `bun test tests/core/system-prompt-early-exit.test.ts` — FAIL.
- [ ] Add one ≤120-char directive next to `Web research:`; if compact budget exceeded, shorten a neighbouring directive, not the guard.
- [ ] Run `bun test tests/core/system-prompt-early-exit.test.ts tests/core/system-prompt-compact.test.ts` — PASS.
- [ ] Commit `fix(prompt): early exit when fetched page already answers`.

### Task 2: circuit breaker для MCP

**Files:** Modify `src/tools/mcp-call.ts:7-10,75-102`, `src/i18n/en.json`, `src/i18n/ru.json`; Test `tests/tools/mcp-call.test.ts`

- [ ] Add failing tests: 2 consecutive failures → 3rd call refused without transport; success resets counter; refusal message mentions cooldown.
- [ ] Run `bun test tests/tools/mcp-call.test.ts` — FAIL.
- [ ] Add `mcpFailures` Map + `mcpBlockedUntil` Map, threshold `2`, cooldown `60_000`; add `tool.mcp_circuit_open` to both dictionaries.
- [ ] Run `bun test tests/tools/mcp-call.test.ts tests/i18n.test.ts` — PASS.
- [ ] Commit `fix(mcp): circuit breaker after two consecutive failures`.

### Task 3: ограничение `chunk_query`

**Files:** Modify `src/tools/chunk-query.ts:13-17,33-41,90-109`, `src/i18n/en.json`, `src/i18n/ru.json`; Test `tests/tools/chunk-query.test.ts`, `tests/chunk-query.test.ts`

- [ ] Add failing tests: `max_chunks` exceeded → `success:false` + actionable message; normal report unchanged.
- [ ] Run targeted tests — FAIL.
- [ ] Add param, i18n keys, pre-check before `runChunkQuery`; description warns against use after successful `web_fetch`.
- [ ] Run both chunk-query suites + i18n — PASS.
- [ ] Commit `fix(chunk_query): cap chunks and warn about redundant use`.

### Task 4: усечение длинных строк grep

**Files:** Modify `src/tools/grep-tool.ts:7-18`; Test `tests/grep-tool.test.ts`

- [ ] Add failing test: 5 000-char matching line is truncated to ≤300 chars with a marker; 15-line cap still works.
- [ ] Run `bun test tests/grep-tool.test.ts` — FAIL.
- [ ] Export `truncateMatchLines()` and apply before `truncateLines()` in all three engines.
- [ ] Run test — PASS.
- [ ] Commit `fix(grep): truncate long matching lines`.

### Task 5: сужение схемы тулов (`web` tag)

**Files:** Modify `src/tools/auto-tags.ts:20-31,36-37,62-83`, `src/tools/{web-search,web-fetch,web-browse,download-file}.ts`, `src/tools/{mcp-call,chunk-query,scan-corpus,search-history}.ts`; Test `tests/tools-auto-tags.test.ts`, `tests/tools-tags.test.ts`

- [ ] Add failing tests: web-intent infers `web` but not `research`; heavy tools keep only `research`; basic web tools carry both tags.
- [ ] Run targeted tests — FAIL.
- [ ] Add `web` to `KNOWN_TOOL_TAGS`, split `RESEARCH_RE` into web/heavy patterns, retag tools.
- [ ] Run targeted tests + `bun run check:arch` — PASS.
- [ ] Commit `fix(tools): narrow web-intent tool schema`.

### Task 6: метрика `wastefulToolCalls`

**Files:** Modify `src/core/agent/loop-state.ts`, `src/core/agent/loop-state-init.ts`, `src/core/agent/token-tracker.ts:167-171`, `src/core/session-log-telemetry.ts:81`, `src/modules/session/log-types.ts:151`; Test `tests/core/...` (existing loop-state + telemetry suites)

- [ ] Add failing tests: duplicate batch increments counter; failed tool increments counter; value appears in `llm_usage.progress`.
- [ ] Run targeted tests — FAIL.
- [ ] Add optional counter to `LoopState`, init to 0, increment in `recordBatchProgress()` / `recordRepeatedToolFailure()`, extend both `progress` types and logger payload.
- [ ] Run targeted tests — PASS.
- [ ] Commit `fix(observability): log wasteful tool calls`.

### Final

- [ ] `bun test` — all green.
- [ ] `bun run quality` — all green.
- [ ] Review three dimensions (user / model / adjacent modules).
- [ ] No `CHANGELOG.md` edit (AGENTS.md rule 10).
