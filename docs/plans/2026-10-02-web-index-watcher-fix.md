# Web Project-Map Watcher Fix — Implementation Plan

**Goal:** In `mma web`, start/stop the shared project-map file watcher with the web host lifecycle, so the Map sidebar reflects the live workspace instead of showing `устарело` (stale) forever.

**Architecture:** The indexer watcher is currently started only by the indexer plugin's `onSessionStart`, which fires exclusively from the main agent's `Agent.run()`. Web turns run through per-session runners whose plugin manager deliberately excludes the `indexer` plugin (to protect the shared watcher from a runner's `onSessionEnd`), and the legacy main-agent turn path was removed — so in web the watcher is never started at all. Fix: the long-lived web host becomes the watcher owner. A tiny, testable helper attaches the watcher when the web UI starts and detaches it on `stop()`.

**Tech Stack:** Bun + TypeScript (ES2022/NodeNext), vitest (`bun test`), `tsc --noEmit`, Biome.

**Branch:** `refactor/webui-modularize` (per explicit user request; unrelated staged modularization files must NOT be included in any commit).

> No commits in this plan unless the user explicitly asks. Stage only the files listed per task.

---

## Root cause (for reference)

| Fact | Location |
| --- | --- |
| `watch()` is called only from the indexer plugin | `src/modules/indexer/module.ts:223-226` |
| `onSessionStart` fires only from the main agent's `run()` | `src/core/agent.ts:648` |
| Web turns run in per-session runners | `src/modules/webui/run-agent.ts:95` |
| Runner plugins exclude `indexer` | `src/core/bootstrap/session-runner-scope.ts:33` |
| Legacy main-agent web path removed | commit `606a320` |
| Stale indicator = `indexed && !watcher` | `src/modules/webui/assets/js/sidebar.js:787` |
| `refresh()` rebuilds the index but never arms the watcher | `src/modules/indexer/module.ts:83` |

---

## File Structure

- **Modify** `src/modules/webui/host-state.ts` — widen the `WebIndexer` contract with `watch?`/`unwatch?`.
- **Create** `src/modules/webui/index-watcher.ts` — `attachIndexWatcher(indexer)` lifecycle helper (best-effort, stub-safe).
- **Modify** `src/modules/webui/module.ts` — attach on `startWebUi`, detach in `stop()`.
- **Create** `tests/webui-index-watcher.test.ts` — unit tests + a source guard that `module.ts` wires the helper.
- **Modify** `docs/agents/modules.md`, `AGENTS.md`, `CHANGELOG.md` — document the ownership change.

---

### Task 1: Widen the `WebIndexer` contract

**Files:**
- Modify: `src/modules/webui/host-state.ts:34-41`

- [ ] **Step 1: Add optional watcher methods to `WebIndexer`**

```ts
/** Структурное подмножество индексер-модуля для сайдбара (без жёсткой зависимости). */
export interface WebIndexer {
  buildIndex(): Promise<unknown>;
  stats(): { files: number; symbols: number; tokens: number } | null;
  /** Полная статистика карты (вкладка Map); undefined у старых стабов. */
  mapInfo?(): ProjectMapInfo;
  /** Принудительная пересборка индекса (`POST /api/index`). */
  refresh?(): Promise<unknown>;
  /** Подписка на изменения файлов (вотчер). Есть у `IndexerModule`, нет у стабов. */
  watch?(): void;
  /** Отписка от вотчера. */
  unwatch?(): void;
}
```

- [ ] **Step 2: Typecheck the interface change**

Run: `tsc --noEmit`
Expected: PASS (methods optional; no caller breaks).

---

### Task 2: `attachIndexWatcher` helper + tests

**Files:**
- Create: `src/modules/webui/index-watcher.ts`
- Test: `tests/webui-index-watcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attachIndexWatcher,
  type WatchableIndexer,
} from "../src/modules/webui/index-watcher";

describe("attachIndexWatcher", () => {
  it("arms the watcher on attach and disarms it on detach", () => {
    let on = 0;
    let off = 0;
    const indexer: WatchableIndexer = {
      watch: () => {
        on += 1;
      },
      unwatch: () => {
        off += 1;
      },
    };

    const detach = attachIndexWatcher(indexer);
    expect(on).toBe(1);
    expect(off).toBe(0);

    detach();
    expect(off).toBe(1);
  });

  it("is a no-op for a stub without watch/unwatch", () => {
    const detach = attachIndexWatcher(undefined);
    expect(() => detach()).not.toThrow();

    const bare: WatchableIndexer = {};
    expect(() => attachIndexWatcher(bare)()).not.toThrow();
  });

  it("is wired into startWebUi/stop", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "src", "modules", "webui", "module.ts"),
      "utf-8",
    );
    expect(src).toContain("attachIndexWatcher(deps.indexer)");
    expect(src).toContain("detachIndexWatcher()");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/webui-index-watcher.test.ts`
Expected: FAIL — `Cannot find module '../src/modules/webui/index-watcher'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// Вотчер карты проекта на время жизни веб-хоста: `mma web` не гоняет сессию
// главного агента, поэтому REPL-хук плагина индексатора (`onSessionStart`) тут
// не срабатывает. Владельцем общего вотчера становится сам веб-UI. Best-effort:
// стаб без `watch`/`unwatch` (тесты, примеры) — no-op.
import type { WebIndexer } from "./host-state";

/** Узкий контракт вотчера: только подписка/отписка (без жёсткой зависимости). */
export interface WatchableIndexer {
  watch?(): void;
  unwatch?(): void;
}

/** Поднимает вотчер и возвращает функцию отписки. */
export function attachIndexWatcher(indexer?: WebIndexer): () => void {
  const target: WatchableIndexer | undefined = indexer;
  target?.watch?.();
  return () => target?.unwatch?.();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/webui-index-watcher.test.ts`
Expected: PASS (all 3). The third test will still fail until Task 3 wires `module.ts`.

---

### Task 3: Wire the helper into the web UI lifecycle

**Files:**
- Modify: `src/modules/webui/module.ts` (imports; `startWebUi`; `stop()`)

- [ ] **Step 1: Import the helper**

Add next to the other `./host-state` import (line ~28):

```ts
import { attachIndexWatcher } from "./index-watcher";
```

- [ ] **Step 2: Attach the watcher once the host deps are wired**

Inside `startWebUi`, immediately after the `if (deps.indexer) { … }` block (line ~174) add:

```ts
  // Общий вотчер карты: в web сессия главного агента не запускается, поэтому
  // плагин индексатора его не поднимает — владельцем становится веб-хост.
  const detachIndexWatcher = attachIndexWatcher(deps.indexer);
```

- [ ] **Step 3: Detach on stop**

In the returned handle's `stop()` (line ~272):

```ts
    stop: () => {
      detachIndexWatcher();
      cancelPendingQuestions(state);
      stopOutputForwarding();
      state.pool.clear();
      stopServer(state);
    },
```

- [ ] **Step 4: Run the helper test (source guard now passes)**

Run: `bun test tests/webui-index-watcher.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Typecheck**

Run: `tsc --noEmit`
Expected: PASS.

---

### Task 4: Documentation

**Files:**
- Modify: `docs/agents/modules.md:80`
- Modify: `AGENTS.md:536-538`
- Modify: `CHANGELOG.md` (Unreleased → Fixed)

- [ ] **Step 1: `docs/agents/modules.md`** — clarify watcher ownership

Replace the "Re-scans on file changes via a file watcher…" bullet with:

```markdown
- Re-scans on file changes via a file watcher and exposes the result as a system prompt block.
  In the REPL the watcher is armed by the indexer plugin on session start; in `mma web` it is owned by the
  web host (`attachIndexWatcher`, `src/modules/webui/index-watcher.ts`) for the process lifetime, because web
  turns run in per-session runners that intentionally exclude the shared `indexer` plugin.
```

- [ ] **Step 2: `AGENTS.md`** — Map bullet

Append to the **Map** bullet (after the Re-index sentence):

```markdown
  Вотчер карты (`watch`/`unwatch`) в вебе поднимает сам веб-хост (`attachIndexWatcher`,
  `src/modules/webui/index-watcher.ts`) на старте `startWebUi` и снимает в `stop()`: в web
  сессия главного агента не гоняется, поэтому REPL-хук `onSessionStart` индексатора не срабатывает.
```

- [ ] **Step 2b: `AGENTS.md`** — Tests bullet

Append `tests/webui-index-watcher.test.ts` to the Map tests list.

- [ ] **Step 3: `CHANGELOG.md`** — add under `## [Unreleased]` → `### Fixed`

```markdown
- **Web project-map watcher is now armed** (`src/modules/webui/index-watcher.ts`, `module.ts`, `host-state.ts`): the Map sidebar permanently showed **stale** in `mma web` because the indexer's file watcher was started only by the indexer plugin's `onSessionStart`, which fires from the main agent's `run()` — and web turns run in per-session runners whose plugin manager deliberately excludes the `indexer` plugin. The long-lived web host now owns the shared watcher (`attachIndexWatcher` on `startWebUi`, detached on `stop()`), so the map auto-rebuilds on file changes and **Re-index** no longer looks inert. Tests: `tests/webui-index-watcher.test.ts`.
```

---

### Task 5: Verification

- [ ] **Step 1: Targeted tests**

Run: `bun test tests/webui-index-watcher.test.ts tests/indexer-module.test.ts tests/modules/indexer/watcher.test.ts tests/webui-server.test.ts`
Expected: PASS.

- [ ] **Step 2: Full test suite + typecheck + lint**

Run: `bun test`
Run: `tsc --noEmit`
Run: `bun run lint`
Expected: all green.

- [ ] **Step 3 (manual, optional): live web check** — isolated config, no browser

```powershell
$env:MMA_CONFIG_DIR = "$env:TEMP\mma-watcher-check"
bun run mma web --no-open --port 8791   # in one shell
# other shell:
curl.exe -s http://127.0.0.1:8791/api/state | Select-String '"watcher":true'
curl.exe -s -X POST http://127.0.0.1:8791/api/index
```

Expected: `/api/state` reports `projectMap.watcher: true` (status `ready`, not `stale`), and the Map counts/`updatedAt` refresh after touching a file.

---

## Self-review

- **Spec coverage:** "always stale" → Tasks 1-3; "button does nothing" → same (watcher armed → status no longer permanently stale; Re-index still rebuilds). Docs → Task 4. Verification → Task 5.
- **Placeholders:** none.
- **Type consistency:** `WebIndexer.watch?/unwatch?` (Task 1) → `WatchableIndexer`/`attachIndexWatcher` (Task 2) → `attachIndexWatcher(deps.indexer)` / `detachIndexWatcher()` (Task 3) → source guard strings (Task 2 test) match Task 3 verbatim.
- **Out of scope (noted, not done):** making `Indexer.watch()` report whether a watcher was actually attached (falls back to `watcherActive=true` even if zero dirs watchable). Separate concern; the reported bug is that the watcher is never attempted.
