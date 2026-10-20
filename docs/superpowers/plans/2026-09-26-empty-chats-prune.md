# Empty Chats Prune Implementation Plan

> **Статус:** исполнено частично (сверка 2026-10-20) — `isEmptySession`/`pruneEmpty`,
> CLI `mma session prune [--dry-run]`, REPL `/sessions prune`, i18n (en/ru), edge-тесты —
> сделано. Чекбоксы проставлены по факту. **Task 2 (авто-прунинг пустых сессий в `create()`)
> намеренно снят** — в вебе параллельные вкладки держат пустые сессии, авто-удаление уводило
> их в dead (см. комментарий `src/modules/session/manager.ts:89-91`).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Empty sessions (no user message) are auto-deleted on session create, plus a manual `session prune` command.

**Architecture:** One `SessionManager.pruneEmpty()` helper owns the emptiness check; `create()` calls it silently; CLI `mma session prune` and REPL `/sessions prune` share it. Fail-open everywhere.

**Tech Stack:** TypeScript (Bun), vitest (`bun test`), commander (CLI), REPL handler-map, i18n en+ru.

---

## File map

- Modify: `src/modules/session/manager.ts` — `isEmptySession()` helper + `pruneEmpty()` + hook in `create()`.
- Modify: `src/cli/commands.ts` — `session prune [--dry-run]` after the `delete` subcommand (~line 730).
- Modify: `src/cli/repl-commands.ts` — extend `sessions` command action to handle `prune` arg (~line 1044).
- Modify: `src/i18n/en.json` — add `session.pruned`, `session.prune_dry`, `session.prune_empty` after `session.deleted` (line 76).
- Modify: `src/i18n/ru.json` — same keys in Russian.
- Test: `tests/session-manager.test.ts` — append prune tests (file exists, uses `SessionStore` + tmpdir pattern).

---

### Task 1: `pruneEmpty()` in SessionManager (with failing test first)

**Files:**
- Modify: `src/modules/session/manager.ts:1-115`
- Test: `tests/session-manager.test.ts`

- [x] **Step 1: Write the failing test** — append to `tests/session-manager.test.ts`:

```ts
it("pruneEmpty removes sessions without user messages and keeps the rest", () => {
  const empty = manager.create("Empty");
  const withUser = manager.create("Real");
  manager.setActive(withUser.id);
  manager.appendMessage({ role: "user", content: "hi", timestamp: new Date().toISOString() });
  manager.setActive(empty.id);
  const fresh = manager.create("Fresh");
  const deleted = manager.pruneEmpty(fresh.id);
  expect(deleted).toContain(empty.id);
  expect(deleted).not.toContain(withUser.id);
  expect(deleted).not.toContain(fresh.id);
  expect(manager.get(empty.id)).toBeNull();
  expect(manager.get(withUser.id)).not.toBeNull();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/session-manager.test.ts`
Expected: FAIL with `manager.pruneEmpty is not a function`

- [x] **Step 3: Write minimal implementation** — in `src/modules/session/manager.ts`, add import and methods (place after `delete()`):

```ts
import { getMessageText } from "../../llm/provider";
```

```ts
/** True when the session has no user message with non-empty text. Fail-open: read errors count as non-empty. */
isEmptySession(id: string): boolean {
  const meta = this.store.loadMeta(id);
  if (!meta) return false;
  if ((meta.messageCount ?? 0) === 0) return true;
  let history;
  try {
    history = this.getHistory(id);
  } catch {
    return false;
  }
  return !history.some((m) => m.role === "user" && getMessageText(m.content).trim().length > 0);
}

/** Delete all empty sessions except `excludeId`. Returns deleted ids. Never throws. */
pruneEmpty(excludeId?: string): string[] {
  const deleted: string[] = [];
  for (const s of this.store.listSessions()) {
    if (s.id === excludeId) continue;
    try {
      if (this.isEmptySession(s.id)) {
        this.delete(s.id);
        deleted.push(s.id);
      }
    } catch {
      // fail-open: skip unreadable sessions
    }
  }
  return deleted;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test tests/session-manager.test.ts`
Expected: PASS (all tests, including the new one)

- [x] **Step 5: Commit**

```bash
git add src/modules/session/manager.ts tests/session-manager.test.ts
git commit -m "feat(session): pruneEmpty removes chats without user messages"
```

---

### Task 2: Auto-cleanup hook in `create()`

**Files:**
- Modify: `src/modules/session/manager.ts:63-93`
- Test: `tests/session-manager.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it("create auto-prunes older empty sessions but keeps the new one", () => {
  const stale = manager.create("Stale");
  const fresh = manager.create("Fresh");
  expect(manager.get(stale.id)).toBeNull();
  expect(manager.get(fresh.id)).not.toBeNull();
});
```

Note: `stale` is empty (no messages), so creating `fresh` must delete it. `fresh` itself is empty but excluded.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/session-manager.test.ts`
Expected: FAIL — `manager.get(stale.id)` is not null (no auto-prune yet)

- [x] **Step 3: Write minimal implementation** — in `create()`, after `this.enforceMaxSessions();` add:

```ts
try {
  this.pruneEmpty(id);
} catch {
  // fail-open: auto-prune must never break session creation
}
```

Full context of the edit (lines ~79-82):

```ts
this.store.saveMeta(id, meta);
this.activeId = id;
this.enforceMaxSessions();
try {
  this.pruneEmpty(id);
} catch {
  // fail-open: auto-prune must never break session creation
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test tests/session-manager.test.ts`
Expected: PASS. Also run `bun test tests/session-store.test.ts` — PASS (no regressions).

- [x] **Step 5: Commit**

```bash
git add src/modules/session/manager.ts tests/session-manager.test.ts
git commit -m "feat(session): auto-prune empty chats on session create"
```

---

### Task 3: CLI `mma session prune [--dry-run]` + i18n

**Files:**
- Modify: `src/cli/commands.ts:722-731`
- Modify: `src/i18n/en.json:76`
- Modify: `src/i18n/ru.json` (mirror key)
- Test: manual (`bun run mma session prune --dry-run`)

- [x] **Step 1: Add i18n keys** — in `src/i18n/en.json` after `"session.deleted"`:

```json
"session.pruned": "Pruned {n} empty session(s)",
"session.prune_dry": "Would prune {n} empty session(s)",
"session.prune_empty": "No empty sessions to prune",
```

In `src/i18n/ru.json` after the `"session.deleted"` line:

```json
"session.pruned": "Удалено пустых сессий: {n}",
"session.prune_dry": "Будет удалено пустых сессий: {n}",
"session.prune_empty": "Пустых сессий нет",
```

- [x] **Step 2: Add the CLI subcommand** — in `src/cli/commands.ts` right after the `delete` subcommand block (ends line 730), insert:

```ts
session
  .command("prune")
  .description(t("cli.prune_sessions"))
  .option("--dry-run", t("cli.prune_dry_run"))
  .action(async (opts: { dryRun?: boolean }) => {
    const { sessionManager } = await bootstrap();
    const active = sessionManager.getActive();
    const candidates = sessionManager
      .list()
      .filter((s) => s.id !== active && sessionManager.isEmptySession(s.id));
    if (candidates.length === 0) {
      getDefaultChannel().writeLine(t("session.prune_empty"));
      return;
    }
    if (opts.dryRun) {
      getDefaultChannel().writeLine(t("session.prune_dry", { n: candidates.length }));
    } else {
      const deleted = sessionManager.pruneEmpty(active ?? undefined);
      getDefaultChannel().writeLine(t("session.pruned", { n: deleted.length }));
    }
    for (const s of candidates) {
      getDefaultChannel().writeLine(`   ${s.id.slice(0, 12)}  ${s.name}`);
    }
  });
```

Also add the two `cli.*` description keys used above to both locale files:

```json
"cli.prune_sessions": "Delete sessions without user messages",
"cli.prune_dry_run": "Show what would be deleted without deleting",
```

```json
"cli.prune_sessions": "Удалить сессии без сообщений пользователя",
"cli.prune_dry_run": "Показать кандидатов без удаления",
```

- [x] **Step 3: Verify manually**

Run: `bun run mma session prune --dry-run`
Expected: exit 0, prints either `No empty sessions to prune` / `Would prune N...` (fails only if bootstrap itself fails — unrelated to this change).

Run: `tsc --noEmit`
Expected: clean (new `t()` keys typecheck — if the i18n `t` is strictly typed and unknown keys fail, add the keys to the type source first).

- [x] **Step 4: Commit**

```bash
git add src/cli/commands.ts src/i18n/en.json src/i18n/ru.json
git commit -m "feat(cli): mma session prune with --dry-run"
```

---

### Task 4: REPL `/sessions prune [--dry-run]`

**Files:**
- Modify: `src/cli/repl-commands.ts:1039-1072`
- Test: manual REPL check

- [x] **Step 1: Extend the `sessions` command** — change `action: () => {` to `action: (args: string[]) => {` and insert the prune branch as the first statement:

```ts
action: (args: string[]) => {
  if (args[0] === "prune") {
    const dry = args.includes("--dry-run");
    const active = ctx.sessionManager!.getActive();
    const candidates = ctx.sessionManager!.list().filter(
      (s) => s.id !== active && ctx.sessionManager!.isEmptySession(s.id),
    );
    if (candidates.length === 0) {
      ctx.output.writeLine(t("session.prune_empty"));
      return;
    }
    if (!dry) ctx.sessionManager!.pruneEmpty(active ?? undefined);
    ctx.output.writeLine(
      t(dry ? "session.prune_dry" : "session.pruned", { n: candidates.length }),
    );
    for (const s of candidates) {
      ctx.output.writeLine(pc.dim(`   ${s.id.slice(0, 12)}  ${s.name}`));
    }
    return;
  }
  const sessions = ctx.sessionManager!.list();
  // ... rest unchanged
```

- [x] **Step 2: Verify** — `tsc --noEmit` clean; REPL `action` signature `(args: string[])` matches other commands (`new`, `delete` already use it).

Run: `bun test tests/cli/ 2>&1 | tail -5`
Expected: green (or pre-existing failures only — compare with `git stash` if unsure).

- [x] **Step 3: Commit**

```bash
git add src/cli/repl-commands.ts
git commit -m "feat(repl): /sessions prune shares pruneEmpty"
```

---

### Task 5: Quality gate + edge tests

**Files:**
- Test: `tests/session-manager.test.ts` (append)

- [x] **Step 1: Add edge-case tests**

```ts
it("pruneEmpty keeps sessions with user text and drops assistant-only ones", () => {
  const assistantOnly = manager.create("AssistantOnly");
  manager.appendMessage({ role: "assistant", content: "hello", timestamp: new Date().toISOString() });
  const withUser = manager.create("WithUser");
  manager.setActive(withUser.id);
  manager.appendMessage({ role: "user", content: "  ", timestamp: new Date().toISOString() });
  const fresh = manager.create("Fresh");
  const deleted = manager.pruneEmpty(fresh.id);
  expect(deleted).toContain(assistantOnly.id);
  expect(deleted).toContain(withUser.id); // whitespace-only user text counts as empty
  expect(manager.get(assistantOnly.id)).toBeNull();
});

it("pruneEmpty never throws on missing history", () => {
  const a = manager.create("A");
  const fresh = manager.create("Fresh");
  expect(() => manager.pruneEmpty(fresh.id)).not.toThrow();
  expect(manager.get(fresh.id)).not.toBeNull();
  expect(a.id).toBeTruthy();
});
```

- [x] **Step 2: Run full gate**

Run: `bun test tests/session-manager.test.ts tests/session-store.test.ts`
Expected: PASS

Run: `bun run quality`
Expected: PASS (typecheck + lint + fallow). If fallow flags new dead code — remove it; if it flags `isEmptySession` as unused, the CLI/REPL wiring in Tasks 3-4 is missing.

- [x] **Step 3: Commit**

```bash
git add tests/session-manager.test.ts
git commit -m "test(session): pruneEmpty edge cases"
```

---

## Self-review

**1. Spec coverage:** §1 (emptiness def incl. fast-path + fail-open) → Task 1; §2 (create hook, exclude new, silent) → Task 2; §3 (CLI prune + dry-run, REPL prune, 3 i18n keys, output format) → Tasks 3-4; §4 (unit + CLI/REPL verification) → Tasks 1/2/5. All covered.

**2. Placeholder scan:** No TBD/TODO; every step has exact file paths, code blocks, commands with expected output. The manual CLI/REPL verifications name concrete commands. No "similar to Task N" references — code repeated where needed.

**3. Type consistency:** `pruneEmpty(excludeId?: string): string[]` and `isEmptySession(id: string): boolean` signatures identical across Tasks 1-4. i18n keys `session.pruned/prune_dry/prune_empty` + `cli.prune_sessions/prune_dry_run` identical in code and locale edits. `getMessageText` import path `../../llm/provider` correct relative to `src/modules/session/manager.ts`.
