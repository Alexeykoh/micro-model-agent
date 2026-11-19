# System Prompt Optimization Plan

> **Статус:** исполнено частично (сверка 2026-10-20) — сделано: `KISS/DRY/YAGNI` убраны,
> секции `DONE CONDITIONS`, `STOP AND ASK THE USER WHEN`, `SESSION START`, always-on
> `FORBIDDEN`, классификация отказов в StuckDetector (`timeout/repeat/error_loop`).
> Чекбоксы проставлены по факту. **Осталось:** (а) требование «строка ≤120 символов»
> не выдержано — в `src/core/system-prompt.ts` 14 строк длиннее 120; (б) Task 5
> `scope_drift`/`empty_output` не реализованы — надёжного сигнала нет.
> Ссылка в плане на `docs/plans/2026-08-27-system-prompt-optimization.md` не существует —
> план лежит только здесь.

> **For agentic workers:** implement task-by-task, TDD (test first), atomic commits `feat(scope): description`. Steps use checkbox (`- [ ]`) syntax.

**Status (2026-09-28):** all 6 tasks closed. Task 3 (DONE CONDITIONS + STOP) in `src/core/bootstrap.ts` (branch `feat/system-prompt-done-conditions`). Task 5 (failure classification) in `stuck-detector.ts` — `scope_drift`/`empty_output` intentionally omitted (no reliable detector signal). Tasks 1+2 (Wave 1 restructure + dedup), 4 (SESSION START), 6 (FORBIDDEN) in `src/core/system-prompt.ts` (branch `feat/system-prompt-waves`): header sections ≤120 chars/line (was 20/21 over, max 608), −22% tokens (1744→1360 est.), `Design:` line removed; SESSION START as prompt section (baseline for code tasks only); FORBIDDEN always-on compact (decisions: prompt over plugin-hook, always over autoPlan-only).

**Goal:** Restructure `buildSystemInfo` system prompt for 9B models — reduce token count, improve readability, add missing behavioral directives.

**Source:** AI agent analysis 2026-08-27 (prompt audit against literature best practices).

**Rules honored:** TDD (rule #7), i18n en+ru for any new user-facing string (rule #8), no keyword matching (rule #10), no file >300 lines where avoidable.

**Verification after every task:** `bun test <touched tests>`; at wave end `bun test` + `bunx tsc --noEmit`.

**Out of scope:** AGENTS.md restructuring (already well-structured), plugin system changes, MoE changes.

---

## Findings register (audit 2026-08-27)

Оценка: **5** = критично (ломает агента) … 1 = косметика.

| # | Оценка | Находка | Где | Task |
|---|--------|---------|-----|------|
| SP-1 | **4** | Строки 200+ символов — 9B модели "теряются" в длинных строках (SCOPE DISCIPLINE = 340 символов) | `bootstrap.ts:53` | 1 |
| SP-2 | **4** | Нет section headers — всё слитно в one flowing text, трудно найти нужное | `bootstrap.ts:49-77` | 1 |
| SP-3 | 3 | Дублирование KISS/DRY/YAGNI с AGENTS.md (~20 токенов зря) | `bootstrap.ts:52` | 2 |
| SP-4 | 3 | DEVELOPMENT RULES — 6 пунктов в одной строке (180+ символов) | `bootstrap.ts:73` | 1 |
| SP-5 | 3 | Нет "done conditions" — модель не знает когда остановиться | `bootstrap.ts` | 3 |
| SP-6 | 3 | Нет "stop conditions" — когда спросить пользователя | `bootstrap.ts` | 3 |
| SP-7 | 2 | Нет session start protocol — модель пишет код без проверки baseline | `bootstrap.ts` | 4 |
| SP-8 | 2 | Runtime verification (95 символов) — длинная строка с複�ной логикой | `bootstrap.ts:94` | 1 |

Паттерн: промпт оптимизирован для "полной информации", но 9B модели нужна структурированная, компактная инструкция с чёткими section headers.

---

## Wave 1: Restructure `buildSystemInfo` core (Tasks 1-2)

### Task 1: Rewrite core prompt structure

**Goal:** Replace prose-heavy prompt with structured sections, each ≤100 символов per line.

**Files:** `src/core/bootstrap.ts` (function `buildSystemInfo`, lines 49-77)

**Changes:**

```typescript
// BEFORE (lines 49-55): 5 long strings
const lines: string[] = [
  `You are MMA v2, an AI coding agent for small models (${config.model}). Date: ${now}. Workspace: ${baseDir}. ${profileCompressed}.`,
  `Reply in the user's language. Use tools for file ops (read/write/edit/delete), search (glob/grep), shell (bash), web, subagents, browser, MCP. Explain briefly if not obvious. On tool failure: analyze, fix the call, retry up to 2x with different approaches, then ask the user.`,
  `Design: YAGNI (no unneeded code), KISS (simple over clever), DRY (reuse existing utilities).`,
  `SCOPE DISCIPLINE: do ONLY what the user explicitly asked — no extra features, files, refactors, "improvements", or fixes beyond the request. Read-only requests ("расскажи", "покажи", "объясни", "check") mean READ-ONLY: inspect and answer, never create/modify/delete anything. If the task is ambiguous (what to create, where, which variant) or the request implies action on something you could not find — STOP and ask the user a short clarifying question in plain text instead of guessing.`,
  `NOT FOUND ≠ MISSING PROJECT: a "not found" tool result means the PATH was wrong (typo, different location), not that the project does not exist. Before creating or scaffolding ANY project/files: first run list_dir on the working directory to see what is already there; if a user-named path is not found, list its parent directory to locate the real path. NEVER create a new project when the user asked about an existing one — inspect first, create only after confirming the workspace is empty AND the user asked for creation.`,
];

// AFTER: structured sections
const lines: string[] = [
  `You are MMA v2, coding agent for ${config.model}. Date: ${now}. Workspace: ${baseDir}. ${profileCompressed}. Reply in user's language. Explain briefly if not obvious.`,
  ``,
  `TASK RULES:`,
  `- Do ONLY what user asked — no extra features, files, refactors, "improvements"`,
  `- Read-only requests ("расскажи", "покажи", "объясни") = never create/modify/delete`,
  `- Multi-step tasks → create plan with "plan" tool BEFORE starting`,
  `- Stuck after 2 failures → STOP, try different approach, ask user`,
  `- If ambiguous (what/where/which) → STOP and ask clarifying question`,
  ``,
  `VERIFICATION:`,
  `- After write_file/edit_file → call lsp_check if tool result has NO [LSP errors/warnings]`,
  `- Runtime bugs → reproduce first, then confirm fix against actual output`,
  `- Each plan step = concrete deliverables (exact files, packages, commands)`,
  ``,
  `TECHNICAL:`,
  `- Bun: "bun <file.ts>" directly, "bun test" for tests (no tsx/npm install needed)`,
  `- Bash: use workdir param, one command per call, "background: true" for long-running`,
  `- Install deps BEFORE source code, framework init BEFORE app code`,
  `- "not found" tool result = wrong PATH, not missing project → list_dir first`,
];
```

**Verification:**
- Token count: compare old vs new (expect ~15% reduction)
- `bun test` — existing tests pass
- Manual: run `bun run mma "list files"` — agent works normally

**Commit:** `feat(prompt): restructure buildSystemInfo for 9B readability`

---

### Task 2: Remove KISS/DRY/YAGNI duplication

**Goal:** Remove "Design: YAGNI/KISS/DRY" line — already in AGENTS.md, redundant in system prompt.

**Files:** `src/core/bootstrap.ts` (line 52)

**Changes:**

```typescript
// BEFORE (line 52):
`Design: YAGNI (no unneeded code), KISS (simple over clever), DRY (reuse existing utilities).`,

// AFTER: removed (line already gone in Task 1 restructure)
```

**Verification:**
- `bun test` — existing tests pass
- Check prompt output: KISS/DRY/YAGNI still present via AGENTS.md block

**Commit:** `refactor(prompt): remove KISS/DRY/YAGNI duplication with AGENTS.md`

---

## Wave 2: Add behavioral directives (Tasks 3-4)

### Task 3: Add DONE CONDITIONS and STOP Conditions

**Goal:** Add explicit "when to stop" and "when to ask user" directives.

**Files:** `src/core/bootstrap.ts` (function `buildSystemInfo`)

**Changes:**

```typescript
// Add after VERIFICATION section:
``,
`DONE CONDITIONS:`,
`- All plan steps marked [x]`,
`- Tests pass (if project has tests)`,
`- No LSP errors in modified files`,
`- User confirmed (if request was ambiguous)`,
`Then output summary: "Done: created N files, changed M files"`,
``,
`STOP AND ASK USER WHEN:`,
`- Task is ambiguous (multiple valid approaches)`,
`- You could not find what user asked about`,
`- Task requires deleting/overwriting important files`,
`- You are stuck after 2+ different approaches`,
```

**Verification:**
- `bun test` — existing tests pass
- Manual: verify prompt contains new sections

**Commit:** `feat(prompt): add DONE CONDITIONS and STOP directives`

---

### Task 4: Add SESSION START PROTOCOL (optional, lower priority)

**Goal:** Add baseline verification at session start.

**Files:** `src/modules/execution/execution-plugin.ts` (plugin hook)

**Changes:**

```typescript
// In execution-plugin.ts, add to onSessionStart:
onSessionStart: (ctx) => {
  // Add baseline check message to context (not system prompt)
  ctx.contextManager.addMessage({
    role: "system",
    content: `[SESSION START] Run: list_dir + bun test/tsc --noEmit. Report current state before proceeding.`
  });
}
```

**Alternative (if plugin hook not sufficient):** Add to `buildSystemInfo`:

```typescript
// Add as last section:
``,
`SESSION START (first user message):`,
`1. Inspect workspace: list_dir, check package.json, existing files`,
`2. Verify baseline: bun test / tsc --noEmit (report pass/fail)`,
`3. Summarize state: "Project has X files, Y tests, Z errors"`,
`Then proceed with user's task.`,
``

**Decision needed:** Plugin hook (zero token cost) vs system prompt (guaranteed execution).

**Verification:**
- `bun test` — existing tests pass
- Manual: start new session, verify baseline check runs

**Commit:** `feat(prompt): add session start baseline protocol`

---

## Wave 3: Extend StuckDetector with failure classification (Task 5)

### Task 5: Add failure type classification to stuck messages

**Goal:** Classify stuck reasons (timeout, repeat, error_loop, scope_drift, empty_output) for better recovery.

**Files:** `src/modules/execution/stuck-detector.ts`

**Changes:**

```typescript
// Add type definition:
type FailureType = 
  | "timeout"      // N iterations without progress
  | "repeat"       // 3+ identical tool calls
  | "error_loop"   // same tool failing repeatedly
  | "scope_drift"  // editing files not in plan
  | "empty_output" // model returned empty response

// Update StuckDetector to classify and format:
// [STUCK: type=repeat, tool=bash, count=3, iteration=8]
// Recent calls:
// 1. bash("bun test") → Error: module not found
// 2. bash("bun test") → Error: module not found
// 3. bash("bun test") → Error: module not found
// Suggestion: check import paths in src/app.ts
```

**Verification:**
- `bun test tests/execution/stuck-detector.test.ts` — existing tests pass
- New tests for each FailureType

**Commit:** `feat(execution): add failure type classification to stuck messages`

---

## Wave 4: ANTI-PATTERNS section (Task 6, decision needed)

### Task 6: Add FORBIDDEN patterns section

**Goal:** Explicit list of forbidden actions for 9B models.

**Files:** `src/core/bootstrap.ts` (function `buildSystemInfo`)

**Decision needed:** Include always (~80 tokens) or only when `autoPlan: true`?

**Option A (always):**

```typescript
// Add as last section:
``,
`FORBIDDEN:`,
`- Claiming "fixed" without verification`,
`- Starting new server without checking existing (process_list)`,
`- Writing code for future steps before current done`,
`- Retrying same failed command > 2 times`,
`- Creating files without user request`,
``

**Option B (autoPlan only):**

```typescript
if (config.autoPlan) {
  lines.push(
    ``,
    `FORBIDDEN:`,
    `- Claiming "fixed" without verification`,
    `- Starting new server without checking existing (process_list)`,
    `- Writing code for future steps before current done`,
    `- Retrying same failed command > 2 times`,
    `- Creating files without user request`,
  );
}
```

**Verification:**
- `bun test` — existing tests pass
- Token count comparison: always vs autoPlan-only

**Commit:** `feat(prompt): add FORBIDDEN patterns section`

---

## Definition of Done

- [x] All 6 tasks completed
- [x] `bun test` — all existing tests pass
- [x] `bunx tsc --noEmit` — no type errors
- [x] Token count reduced by ~15% (compare old vs new prompt)
- [x] Manual testing: agent works correctly with new prompt
- [x] AGENTS.md updated with new system prompt structure (if needed)

---

## Open Questions

1. **First 3 Turns Protocol** — plugin hook or system prompt? (Task 4)
2. **Failure Classification** — extend StuckDetector or separate FailureClassifier? (Task 5 — decided: extend)
3. **ANTI-PATTERNS section** — always or autoPlan-only? (Task 6)

---

*Plan created: 2026-08-27. Source: AI agent analysis of `buildSystemInfo` function.*
