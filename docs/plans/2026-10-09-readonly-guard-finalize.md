# Read-only Guard Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop killing legitimately read-only turns — redefine the read-only streak as *exact tool-call repetition*, end every terminal with a forced tool-less final answer, and surface the stop reason in the web chat.

**Architecture:** Replace the "no work mutation" predicate in `ToolBatchExecutor` with a whole-turn exact-duplicate predicate (canonical `(tool, args)` key). On any terminal (duplicate / failed-batches / max-iterations) call a new `Agent.finalizeWithoutTools()` that makes one `chat(history, [])` call and accepts the text, skipping critic/audit/claim gates. Carry a machine `stopReason` through `AgentResult` → SSE `turn_end` → web feed. Fix `grep` fallback on Windows.

**Tech Stack:** Bun + TypeScript, vitest (`bun test`), Biome, `tsc --noEmit`.

**Spec:** `docs/specs/2026-10-09-readonly-guard-finalize-design.md`

---

## File Structure

- Create: `src/core/agent/canonical-args.ts` — canonical tool-call key (sorted keys, path-key normalization).
- Create: `tests/core/canonical-args.test.ts`.
- Modify: `src/core/agent/loop-state.ts` — rename read-only fields, add `seenToolCalls`, `finalizeReason`, `stopReason`.
- Modify: `src/core/agent/constants.ts` — rename read-only constants.
- Modify: `src/core/agent/tool-batch.ts` — duplicate predicate, terminal `finalize` signal, poll exemption.
- Modify: `src/core/types.ts` — `AgentResult.stopReason`.
- Modify: `src/core/agent.ts` — call `finalizeWithoutTools`; result construction.
- Modify: `src/modules/webui/session/forward.ts` — `TurnEndSummary` += `stopReason`/`error`.
- Modify: `src/modules/webui/session/run-agent.ts` — pass `result.error`/`result.stopReason`.
- Modify: `src/modules/webui/assets/js/feed/turn.ts` — render reason.
- Modify: `src/tools/grep-tool.ts` — fall through to JS on shell/spawn engine errors.
- Modify: `src/i18n/en.json`, `src/i18n/ru.json` — directive + banner keys.
- Modify: `src/modules/execution/stuck-detector.ts` — use `canonicalArgsKey`.
- Tests: `tests/core/tool-batch-honest-stop.test.ts` (rename + duplicate predicate), new `tests/core/finalize-no-tools.test.ts`, `tests/tools/grep-tool.test.ts` (or existing grep test), `tests/webui-*` for `turn_end`.

---

### Task 1: Canonical tool-call key

**Files:**
- Create: `src/core/agent/canonical-args.ts`
- Test: `tests/core/canonical-args.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { canonicalArgsKey } from "../../src/core/agent/canonical-args";

describe("canonicalArgsKey", () => {
  it("is stable across object key order", () => {
    expect(canonicalArgsKey("read_file", { path: "a.ts", offset: 10 })).toBe(
      canonicalArgsKey("read_file", { offset: 10, path: "a.ts" }),
    );
  });

  it("differs for different tools or different args", () => {
    expect(canonicalArgsKey("read_file", { path: "a.ts" })).not.toBe(
      canonicalArgsKey("grep", { path: "a.ts" }),
    );
    expect(canonicalArgsKey("read_file", { path: "a.ts" })).not.toBe(
      canonicalArgsKey("read_file", { path: "a.ts", offset: 1 }),
    );
  });

  it("normalizes path-bearing values (separators, ./-prefix, trailing slash)", () => {
    expect(canonicalArgsKey("read_file", { path: "src\\a.ts" })).toBe(
      canonicalArgsKey("read_file", { path: "src/a.ts" }),
    );
    expect(canonicalArgsKey("read_file", { path: "./a.ts" })).toBe(
      canonicalArgsKey("read_file", { path: "a.ts" }),
    );
    expect(canonicalArgsKey("grep", { path: "src/", pattern: "x" })).toBe(
      canonicalArgsKey("grep", { path: "src", pattern: "x" }),
    );
  });

  it("does NOT normalize non-path string values (regex patterns keep backslashes)", () => {
    expect(canonicalArgsKey("grep", { pattern: "a\\.b" })).not.toBe(
      canonicalArgsKey("grep", { pattern: "a/b" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/canonical-args.test.ts`
Expected: FAIL — cannot resolve module `canonical-args`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/agent/canonical-args.ts
/**
 * Стабильная идентичность вызова тула для детекции дословных повторов:
 * имя + канонические аргументы (рекурсивная сортировка ключей, нормализация
 * path-подобных значений). Совпадает ⟺ вызов буквально тот же.
 */
const PATH_ARG_KEYS = new Set(["path", "file", "workdir", "cwd", "dir", "directory", "target"]);

/** Нормализует значение path-аргумента: слеши → `/`, срез `./`, срез хвостового `/`. */
function normalizePathString(value: string): string {
  let v = value.replace(/\\/g, "/");
  while (v.startsWith("./")) v = v.slice(2);
  if (v.length > 1) v = v.replace(/\/+$/, "");
  return v;
}

function stableStringify(value: unknown, pathValue: boolean): string {
  if (value === null || typeof value !== "object") {
    if (pathValue && typeof value === "string") return JSON.stringify(normalizePathString(value));
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v, pathValue)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], pathValue || PATH_ARG_KEYS.has(k))}`)
    .join(",")}}`;
}

/** Канонический ключ вызова: `name::canonicalArgs`. */
export function canonicalArgsKey(name: string, args: unknown): string {
  return `${name}::${stableStringify(args, false)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/canonical-args.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/agent/canonical-args.ts tests/core/canonical-args.test.ts
git commit -m "feat(agent): canonical tool-call key for duplicate detection"
```

---

### Task 2: LoopState + constants rename, add `seenToolCalls` / `finalizeReason` / `stopReason`

**Files:**
- Modify: `src/core/agent/loop-state.ts`
- Modify: `src/core/agent/constants.ts`

- [ ] **Step 1: Rename constants in `src/core/agent/constants.ts`**

Replace the `MAX_READONLY_BATCHES` / `HARD_STOP_READONLY_BATCHES` block (lines 65–77) with:

```ts
/**
 * Подряд идущие пакеты, где КАЖДЫЙ вызов дословно повторяет уже сделанный за
 * ход (имя + канонические аргументы). Детект не «нет мутации», а «нет нового
 * действия»: широкая разведка новыми файлами/паттернами прогрессирует и стрик
 * не набирает. Порог директивы «перестань повторяться — ответь».
 */
export const MAX_DUPLICATE_BATCHES = 8;
/** Жёсткий терминал: столько дублирующих пакетов подряд — форс финального ответа. */
export const HARD_STOP_DUPLICATE_BATCHES = 12;
```

- [ ] **Step 2: Update `LoopState` fields in `src/core/agent/loop-state.ts`**

Rename `consecutiveReadOnlyBatches` → `consecutiveDuplicateBatches`, `readonlyNudged` → `duplicateNudged`, `readonlyStopped` → `duplicateStopped`. Update the doc comment on `consecutiveDuplicateBatches`:

```ts
  /**
   * Подряд идущие пакеты, где каждый вызов — дословный дубль уже сделанного
   * за ход. Питает duplicate-бюджет: директива «ответь», затем форс-финал.
   */
  consecutiveDuplicateBatches: number;
  /** Директива duplicate-бюджета уже отправлена для текущего стрика (1 раз). */
  duplicateNudged: boolean;
  /** Duplicate-петля достигла терминала — цикл обязан форсировать финал. */
  duplicateStopped: boolean;
```

Add new fields (near the read-only group):

```ts
  /** Канонические ключи всех вызовов за ход — вход duplicate-предиката. */
  seenToolCalls: Set<string>;
  /** Причина принудительного завершения без тулов, или null. */
  finalizeReason: "duplicate" | "failed_batches" | "max_iters" | null;
  /** Машиночитаемая причина остановки для результата/чата (после финала). */
  stopReason: "duplicate" | "failed_batches" | "max_iters" | null;
```

In `createLoopState()`, apply the same renames and set the new defaults:

```ts
    consecutiveDuplicateBatches: 0,
    duplicateNudged: false,
    duplicateStopped: false,
    seenToolCalls: new Set<string>(),
    finalizeReason: null,
    stopReason: null,
```

- [ ] **Step 3: Typecheck**

Run: `tsc --noEmit`
Expected: errors ONLY at the call sites that still use the old names (`tool-batch.ts`, `agent.ts`). These are fixed in Tasks 3–4.

- [ ] **Step 4: Commit**

```bash
git add src/core/agent/loop-state.ts src/core/agent/constants.ts
git commit -m "refactor(agent): rename read-only budget fields to duplicate semantics"
```

---

### Task 3: Duplicate predicate + terminal signal in `ToolBatchExecutor`

**Files:**
- Modify: `src/core/agent/tool-batch.ts`
- Test: `tests/core/tool-batch-honest-stop.test.ts` (rename + rewrite the read-only describe)

- [ ] **Step 1: Update the failing/duplicate tests**

In `tests/core/tool-batch-honest-stop.test.ts`, rename the `runReadonlyBatch` helper and rewrite `describe("ToolBatchExecutor read-only budget", ...)` (lines ~132–206) to:

```ts
async function runBatchOf(
  ex: ToolBatchExecutor,
  state: ReturnType<typeof createLoopState>,
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
) {
  (ex as any).deps.toolExecutor.execute = async () => ok;
  return ex.execute(state, calls, new Set(), "", "", "task");
}

function hasDuplicateDirective(added: string[]): boolean {
  return added.some((m) => m.includes("only been reading") || m.includes("только читаешь"));
}

const sameCall = { id: "1", name: "read_file", arguments: { path: "src/a.ts" } };

describe("ToolBatchExecutor duplicate budget", () => {
  it("varied reads are progress — never fires", async () => {
    const { added, ex, state } = makeCase();
    for (let n = 0; n < 20; n++) {
      const r = await runBatchOf(ex, state, [
        { id: String(n), name: "read_file", arguments: { path: `src/f${n}.ts` } },
      ]);
      expect(r.interrupted).toBe(false);
      expect(r.finalize).toBeUndefined();
    }
    expect(state.consecutiveDuplicateBatches).toBe(0);
    expect(hasDuplicateDirective(added)).toBe(false);
  });

  it("directive on the 8th identical batch, finalize on the 12th", async () => {
    const { added, ex, state } = makeCase();
    for (let n = 0; n < 7; n++) {
      const r = await runBatchOf(ex, state, [sameCall]);
      expect(r.finalize).toBeUndefined();
    }
    const eighth = await runBatchOf(ex, state, [sameCall]);
    expect(eighth.finalize).toBeUndefined();
    expect(state.consecutiveDuplicateBatches).toBe(8);
    expect(hasDuplicateDirective(added)).toBe(true);

    for (let n = 0; n < 3; n++) await runBatchOf(ex, state, [sameCall]);
    const twelfth = await runBatchOf(ex, state, [sameCall]);
    expect(twelfth.finalize).toBe("duplicate");
    expect(state.duplicateStopped).toBe(true);
  });

  it("a fresh call resets the duplicate streak", async () => {
    const { ex, state } = makeCase();
    await runBatchOf(ex, state, [sameCall]);
    await runBatchOf(ex, state, [sameCall]);
    expect(state.consecutiveDuplicateBatches).toBe(2);
    await runBatchOf(ex, state, [
      { id: "9", name: "read_file", arguments: { path: "src/other.ts" } },
    ]);
    expect(state.consecutiveDuplicateBatches).toBe(0);
  });

  it("a pure process_log poll does not feed the streak", async () => {
    const { ex, state } = makeCase();
    const poll = { id: "1", name: "process_log", arguments: { id: "p1" } };
    for (let n = 0; n < 15; n++) {
      const r = await runBatchOf(ex, state, [poll]);
      expect(r.finalize).toBeUndefined();
    }
    expect(state.consecutiveDuplicateBatches).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/tool-batch-honest-stop.test.ts`
Expected: FAIL — `r.finalize` unknown / `consecutiveDuplicateBatches` undefined.

- [ ] **Step 3: Update imports and the return type in `src/core/agent/tool-batch.ts`**

Replace the constants import (line 27) and drop the `isWorkMutation` import (line 28):

```ts
import { MAX_CONSECUTIVE_TOOL_FAILURES, MIN_REPEATED_TOOL_FAILURES, MAX_CONSECUTIVE_FAILED_BATCHES, HARD_STOP_FAILED_BATCHES, MAX_DUPLICATE_BATCHES, HARD_STOP_DUPLICATE_BATCHES } from "./constants";
import { canonicalArgsKey } from "./canonical-args";
```

Extend the result interface (line 99):

```ts
export interface ToolBatchExecution {
  /** Истинно, если итерация прервана по shutdown — цикл должен выйти. */
  interrupted: boolean;
  /** Терминал: цикл должен выйти и форсировать финальный ответ без тулов. */
  finalize?: "duplicate" | "failed_batches";
}
```

- [ ] **Step 4: Replace the read-only block in `execute()` (lines ~671–699)**

Replace it with the duplicate predicate:

```ts
    // Duplicate-бюджет: серия пакетов, где КАЖДЫЙ вызов дословно повторяет уже
    // сделанный за ход (канонический ключ). Широкая разведка новыми файлами и
    // паттернами прогрессирует — стрик не набирает. Опрос процесса
    // (process_log/process_wait) — легитимный повтор, стрик не питает.
    const POLL_TOOLS = new Set(["process_log", "process_wait"]);
    const isPurePoll = toolCalls.length > 0 && toolCalls.every((c) => POLL_TOOLS.has(c.name));
    const isDuplicateBatch =
      !isPurePoll &&
      toolCalls.length > 0 &&
      toolCalls.every((c) => state.seenToolCalls.has(canonicalArgsKey(c.name, c.arguments)));
    for (const c of toolCalls) state.seenToolCalls.add(canonicalArgsKey(c.name, c.arguments));

    if (isDuplicateBatch) {
      state.consecutiveDuplicateBatches++;
    } else {
      state.consecutiveDuplicateBatches = 0;
      state.duplicateNudged = false;
    }
    if (state.consecutiveDuplicateBatches >= MAX_DUPLICATE_BATCHES && !state.duplicateNudged) {
      state.duplicateNudged = true;
      logger.diagnostic(
        "warn",
        `Duplicate tool-call streak: ${state.consecutiveDuplicateBatches} batches — directive`,
      );
      contextManager.addMessage({
        role: "user",
        content: `<system-summary>${t("exec.readonly_directive", { count: state.consecutiveDuplicateBatches })}</system-summary>`,
      });
    }
    if (state.consecutiveDuplicateBatches >= HARD_STOP_DUPLICATE_BATCHES) {
      state.duplicateStopped = true;
      logger.diagnostic(
        "warn",
        `Duplicate loop terminated after ${state.consecutiveDuplicateBatches} identical batches — forcing final answer`,
      );
      return { interrupted: false, finalize: "duplicate" };
    }
```

- [ ] **Step 5: Change the failed-batch hard-stop to a finalize signal**

In the honest-stop block (lines ~662–668), replace:

```ts
    if (state.consecutiveFailedBatches >= HARD_STOP_FAILED_BATCHES) {
      state.retryLoopStopped = true;
      logger.diagnostic(
        "warn",
        `Retry loop hard-stopped after ${state.consecutiveFailedBatches} consecutive failed batches`,
      );
      return { interrupted: true };
    }
```

with:

```ts
    if (state.consecutiveFailedBatches >= HARD_STOP_FAILED_BATCHES) {
      logger.diagnostic(
        "warn",
        `Retry loop terminated after ${state.consecutiveFailedBatches} consecutive failed batches — forcing final answer`,
      );
      return { interrupted: false, finalize: "failed_batches" };
    }
```

- [ ] **Step 6: Run tests**

Run: `bun test tests/core/tool-batch-honest-stop.test.ts`
Expected: PASS. (The honest-stop test that asserted `state.retryLoopStopped` now asserts `sixth.finalize === "failed_batches"` — update that assertion in the same file.)

- [ ] **Step 7: Commit**

```bash
git add src/core/agent/tool-batch.ts tests/core/tool-batch-honest-stop.test.ts
git commit -m "fix(agent): duplicate tool-call predicate + finalize terminal"
```

---

### Task 4: `finalizeWithoutTools` + loop wiring

**Files:**
- Modify: `src/core/agent.ts`
- Modify: `src/core/types.ts` (`AgentResult.stopReason`)
- Test: create `tests/core/finalize-no-tools.test.ts`

- [ ] **Step 1: Add `stopReason` to `AgentResult` (`src/core/types.ts`, after `interrupted?`)**

```ts
  /**
   * Харнесс завершил ход принудительно (дубль-петля / серия провалов /
   * исчерпание итераций). Ответ — лучшее из собранного, без проверки тулами.
   */
  stopReason?: "duplicate" | "failed_batches" | "max_iters";
```

- [ ] **Step 2: Write the failing test**

Copy the `createMockDeps(chatImpl?)` builder verbatim from
`tests/core/agent-turn-end.test.ts` (lines 5–123) to the top of a new file
`tests/core/finalize-no-tools.test.ts`, then add:

```ts
// tests/core/finalize-no-tools.test.ts  (after the copied createMockDeps)
import { describe, it, expect } from "vitest";
import { Agent } from "../../src/core/agent";
import { createLoopState } from "../../src/core/agent/loop-state";

function textThenDone(text: string) {
  return () =>
    (async function* () {
      yield { type: "text" as const, content: text };
      yield { type: "done" as const, finishReason: "stop" as const };
    })();
}

describe("Agent.finalizeWithoutTools", () => {
  it("produces a final answer via a tool-less call and marks success", async () => {
    const t = createMockDeps(textThenDone("Final answer from gathered evidence."));
    const agent = new Agent(t.deps);
    const state = createLoopState();
    state.iteration = 3;
    const chunks: string[] = [];
    const text = await (agent as any).finalizeWithoutTools(state, (c: string) => chunks.push(c));
    expect(text).toContain("Final answer");
    expect(chunks.join("")).toContain("Final answer");
    expect(state.lastText).toContain("Final answer");
    expect(state.finalAnswerAccepted).toBe(true);
    // The chat call received an EMPTY tool set.
    const [, tools] = t.provider.chat.mock.calls.at(-1)!;
    expect(tools).toEqual([]);
  });

  it("leaves finalAnswerAccepted false when the model returns nothing", async () => {
    const t = createMockDeps(() => (async function* () {})());
    const agent = new Agent(t.deps);
    const state = createLoopState();
    state.iteration = 3;
    await (agent as any).finalizeWithoutTools(state);
    expect(state.finalAnswerAccepted).toBe(false);
    expect(state.lastText).toBe("");
  });
});
```

> `createMockDeps` uses `vi.fn()` from vitest — import `vi` alongside `describe/it/expect` in the copied header if the copy does not already include it. The builder's `chat` mock signature takes `(history, tools, signal, opts)`, so `mock.calls.at(-1)![1]` is the tools array.

- [ ] **Step 3: Run to verify it fails**

Run: `bun test tests/core/finalize-no-tools.test.ts`
Expected: FAIL — `finalizeWithoutTools` is not a function.

- [ ] **Step 4: Implement the method in `src/core/agent.ts`**

Add near `emitPhase` (after the private helpers, ~line 560):

```ts
  /**
   * Аварийное завершение без тулов: один вызов модели с пустым набором
   * инструментов. Ответ принимается как финальный; гейты (critic/audit/claim)
   * пропускаются — мы остановились именно потому, что проверить нечем.
   * Возвращает текст ответа (пустой — нечего финализировать).
   */
  private async finalizeWithoutTools(
    state: LoopState,
    onChunk?: (chunk: string) => void,
  ): Promise<string> {
    const { contextManager, logger, llmProvider } = this.deps;
    contextManager.addMessage({
      role: "user",
      content: `<system-summary>${t("exec.finalize_no_tools")}</system-summary>`,
    });
    const history = repairToolCallPairing(contextManager.getActiveHistory());
    let text = "";
    try {
      for await (const chunk of llmProvider.chat(
        history,
        [],
        this.abortController?.signal,
        { sessionId: this.deps.sessionManager?.getActiveMeta()?.id },
      )) {
        if (this.shutdownRequested) break;
        if (chunk.type === "text" && chunk.content) {
          text += chunk.content;
          onChunk?.(chunk.content);
        }
      }
    } catch (e) {
      logger.diagnostic("warn", `finalizeWithoutTools failed: ${errMsg(e)}`);
    }
    if (text.trim()) {
      state.lastText = text;
      state.finalAnswerAccepted = true;
    }
    return text;
  }
```

Ensure `repairToolCallPairing` is imported (it is already used in the loop) and `errMsg` is imported (`src/utils`).

- [ ] **Step 5: Wire the terminal in the loop**

(a) After `const batch = await toolBatch.execute(...)` (returns at line ~1363), before `if (batch.interrupted) break;` add:

```ts
        if (batch.finalize) {
          state.finalizeReason = batch.finalize;
          break;
        }
```

(b) After the `while` loop ends (before the `const tokensUsed = ...` block at line ~1521), add:

```ts
    if (state.finalizeReason || (state.iteration >= config.maxToolIterations && !state.finalAnswerAccepted)) {
      const reason = state.finalizeReason ?? "max_iters";
      logger.diagnostic("info", `Forcing final answer without tools (${reason})`);
      await this.finalizeWithoutTools(state, onChunk);
      state.stopReason = reason;
    }
```

(c) In the `max_iters` return block (line ~1526), keep as-is but only reached when the forced call produced nothing:

```ts
    if (state.iteration >= config.maxToolIterations && !state.finalAnswerAccepted) {
      return {
        success: false,
        text: state.lastText,
        error: t("error.max_iters", { max: config.maxToolIterations }),
        ...
        stopReason: state.stopReason ?? undefined,
      };
    }
```

(d) In the final result object (line ~1546), remove `state.retryLoopStopped || state.readonlyStopped` from the `success` formula (those fields no longer exist) and add `stopReason`:

```ts
    return {
      success: !(
        this.shutdownRequested ||
        state.emptyResponseExhausted ||
        state.auditFailed
      ),
      interrupted: this.shutdownRequested || undefined,
      stopReason: state.stopReason ?? undefined,
      text: state.lastText,
      error: state.emptyResponseExhausted
        ? t("error.empty_response")
        : state.auditFailed
          ? t("error.audit_failed", { summary: state.lastAuditSummary })
          : undefined,
      ...
```

Also delete the now-dead `state.retryLoopStopped` / `state.readonlyStopped` branches from the `error` ternary (lines ~1560–1564).

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test tests/core/finalize-no-tools.test.ts && bun test tests/core/tool-batch-honest-stop.test.ts && tsc --noEmit`
Expected: PASS + no type errors (the old `retryLoopStopped`/`readonlyStopped` references are gone).

- [ ] **Step 7: Commit**

```bash
git add src/core/agent.ts src/core/types.ts tests/core/finalize-no-tools.test.ts
git commit -m "feat(agent): tool-less final answer on every terminal"
```

---

### Task 5: i18n keys (directive wording + finalize banner)

**Files:**
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`

- [ ] **Step 1: Add/update keys**

In `src/i18n/en.json`:

```json
  "exec.finalize_no_tools": "Tools are now disabled. Write your final answer from what you have already gathered. Do not request tools or ask to continue; state plainly what you found and, if the task is incomplete, what remains unverified.",
```

Update `error.readonly_loop_stopped`:

```json
  "error.readonly_loop_stopped": "Stopped after {count} repeated identical tool calls — the agent kept issuing the same action instead of answering",
```

In `src/i18n/ru.json`:

```json
  "exec.finalize_no_tools": "Инструменты отключены. Напиши финальный ответ на основе того, что уже собрал. Не запрашивай инструменты и не проси продолжить; честно укажи, что найдено, а что осталось непроверенным.",
```

```json
  "error.readonly_loop_stopped": "Остановлено после {count} повторов одного и того же вызова — агент повторял одно действие вместо ответа",
```

- [ ] **Step 2: Verify both dictionaries parse and keys align**

Run: `bun test tests/i18n.test.ts`
Expected: PASS (the repo asserts en/ru key parity).

- [ ] **Step 3: Commit**

```bash
git add src/i18n/en.json src/i18n/ru.json
git commit -m "i18n(agent): finalize directive + duplicate-stop wording"
```

---

### Task 6: Reason in the web chat

**Files:**
- Modify: `src/modules/webui/session/forward.ts`
- Modify: `src/modules/webui/session/run-agent.ts`
- Modify: `src/modules/webui/assets/js/feed/turn.ts`
- Test: extend an existing webui test (e.g. `tests/webui-usage.test.ts` or a new `tests/webui-turn-end-reason.test.ts`)

- [ ] **Step 1: Write the failing test**

```ts
// tests/webui-turn-end-reason.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("turn_end stop reason", () => {
  it("forwards result.error and stopReason through run-agent", () => {
    const src = readFileSync("src/modules/webui/session/run-agent.ts", "utf8");
    expect(src).toMatch(/stopReason:\s*result\.stopReason/);
    expect(src).toMatch(/error:\s*result\.error/);
  });
  it("feed renders the reason instead of only the generic failed line", () => {
    const src = readFileSync("src/modules/webui/assets/js/feed/turn.ts", "utf8");
    expect(src).toMatch(/data\.error/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/webui-turn-end-reason.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `TurnEndSummary` (`src/modules/webui/session/forward.ts:83`)**

```ts
export type TurnEndSummary = Pick<TurnSummary, "success" | "interrupted"> &
  Partial<Pick<TurnSummary, "durationMs" | "toolCalls">> & {
    /** Машиночитаемая причина принудительной остановки, если была. */
    stopReason?: "duplicate" | "failed_batches" | "max_iters";
    /** Локализованный текст причины (печатается в ленте). */
    error?: string;
  };
```

- [ ] **Step 4: Pass the fields in `src/modules/webui/session/run-agent.ts:155-160`**

```ts
      forwarder.onTurnEnd({
        success: result.success,
        interrupted: result.interrupted || undefined,
        stopReason: result.stopReason,
        error: result.error,
        durationMs: result.durationMs,
        toolCalls,
      });
```

- [ ] **Step 5: Render in `src/modules/webui/assets/js/feed/turn.ts:271-278`**

Replace the `data.success === false` branch body:

```ts
  if (data.success === false) {
    const reason = data.error || (data.interrupted ? t("web.turn.stopped") : t("web.turn.failed"));
    const cls = data.interrupted ? "warnline" : "errline";
    const glyph = data.interrupted ? "⚠ " : "✗ ";
    appendTo(feed, el("div", cls, glyph + reason));
    announce(reason);
  } else {
```

(If `data.error` is present on a successful forced finalize, prefer showing it too: change the condition to `if (data.success === false || data.error)` and use `warnline`/`⚠` when `data.stopReason` is set.)

- [ ] **Step 6: Run tests**

Run: `bun test tests/webui-turn-end-reason.test.ts tests/webui-assets.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/webui/session/forward.ts src/modules/webui/session/run-agent.ts src/modules/webui/assets/js/feed/turn.ts tests/webui-turn-end-reason.test.ts
git commit -m "fix(web): surface harness stop reason in the turn-end line"
```

---

### Task 7: `grep` alternation fallback on Windows

**Files:**
- Modify: `src/tools/grep-tool.ts`
- Test: `tests/tools/grep-tool.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifySearchError } from "../../src/tools/grep-tool";

describe("grep external engine failure classification", () => {
  it("treats a shell/spawn failure as engine-unavailable (falls through to JS)", () => {
    const shellError = new Error("'bar' is not recognized as an internal or external command");
    expect(classifySearchError(shellError)).toBeNull();
    const notFound = new Error("'rg' is not recognized as an internal or external command");
    expect(classifySearchError(notFound)).toBeNull();
  });

  it("still reports a genuine timeout as a failure", () => {
    const timeout = new Error("search timed out after 30000ms");
    const r = classifySearchError(timeout);
    expect(r?.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/tools/grep-tool.test.ts`
Expected: FAIL — `classifySearchError` is not exported, or returns a failure for the shell error.

- [ ] **Step 3: Export `classifySearchError` and extend it (`src/tools/grep-tool.ts:66-74`)**

```ts
/** Классифицирует ошибку внешнего поиска в результат или null (движок недоступен). */
export function classifySearchError(e: any): ToolResult | null {
  const msg = String(e?.message ?? "");
  if (/timed out/.test(msg)) {
    return { success: false, output: t("error.grep_failed", { message: msg }) };
  }
  if (e?.code === "ENOENT" || e?.status === 1) return null;
  // Шелл-ошибка шима (npm `.cmd`/`.ps1` под Bun идёт через cmd.exe): внешний
  // движок фактически недоступен — не роняем поиск, падаем на JS-движок.
  if (/is not recognized|not operable|command not found|no such file/i.test(msg)) return null;
  return { success: false, output: t("error.grep_failed", { message: msg }) };
}
```

> Note `e?.status === 1` previously returned `{ success: true, output: no_matches }` — verify the current no-match path: exit code 1 is handled in `runSearch` (resolves `""`), so `classifySearchError` never sees `status === 1`; keep the ENOENT/null behavior and the shell-error branch, leave the rest of its contract intact.

- [ ] **Step 4: Run tests**

Run: `bun test tests/tools/grep-tool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/grep-tool.ts tests/tools/grep-tool.test.ts
git commit -m "fix(tools): grep falls back to JS engine on shim spawn errors"
```

---

### Task 8: Reuse the canonical key in `StuckDetector` + full quality gate

**Files:**
- Modify: `src/modules/execution/stuck-detector.ts`

- [ ] **Step 1: Use `canonicalArgsKey` in `recordToolCall` (line ~272)**

```ts
import { canonicalArgsKey } from "../../core/agent/canonical-args";
...
  recordToolCall(name: string, args: Record<string, unknown>): void {
    const argsKey = canonicalArgsKey(name, args);
    this.recentToolCalls.push({ name, argsKey });
    ...
```

(Keep `ToolCallRecord.name`; the repetition checks compare `call.name` and `call.argsKey` — with the name folded into the key this still matches.)

- [ ] **Step 2: Run the affected tests**

Run: `bun test tests/modules/execution` (or the stuck-detector suite)
Expected: PASS.

- [ ] **Step 3: Full gate**

Run: `bun run quality`
Expected: exit 0 (`typecheck` + `typecheck:frontend` + `lint` + `fallow`).

- [ ] **Step 4: Commit**

```bash
git add src/modules/execution/stuck-detector.ts
git commit -m "refactor(execution): share canonical tool-call key in stuck detector"
```

---

## Self-Review

**Spec coverage:**
- §1 predicate → Tasks 1–3. §2 finalize → Task 4. §3 reason in chat → Task 6. §4 grep → Task 7. §5 cleanup → Task 8. Renames → Task 2.
- Spec's max-iterations terminal → Task 4 Step 5(b).
- Spec's i18n wording → Task 5.

**Placeholder scan:** no TBD/TODO/"implement later". Task 4 Step 2 intentionally copies the `createMockDeps` builder from `tests/core/agent-turn-end.test.ts` verbatim (repeating code is preferred over a shared refactor here); the target file and line range are given.

**Type consistency:** `stopReason` is `"duplicate" | "failed_batches" | "max_iters"` in `LoopState`, `AgentResult`, and `TurnEndSummary`. `ToolBatchExecution.finalize` is the narrower `"duplicate" | "failed_batches"` (max-iterations never originates in the batch). Field names `consecutiveDuplicateBatches` / `duplicateNudged` / `duplicateStopped` are used identically in Tasks 2–3. Constants `MAX_DUPLICATE_BATCHES` / `HARD_STOP_DUPLICATE_BATCHES` match between Task 2 and Task 3.

## Verification before completion

- `bun test` (full suite) green.
- `tsc --noEmit` and `tsc -p tsconfig.frontend.json` green.
- `bun run quality` exit 0.
- Re-run the dry-run: with the new predicate, `ses_mv0pirf5_hnmbxj`'s 24 iterations stay at `consecutiveDuplicateBatches === 0`.
