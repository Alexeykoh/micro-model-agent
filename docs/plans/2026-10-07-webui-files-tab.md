# WebUI Files Tab — Implementation Plan

> **Статус:** исполнено (2026-10-20) — Files-tab реализован в master: ленивое дерево
> (`GET /api/files`), просмотр через `/api/file`, attach пути в черновик, live-сигнал
> `filesRevision` через index-watcher. Чекбоксы проставлены по факту.

**Goal:** Добавить в `mma web` вкладку **Files** — ленивое дерево файлов workspace, read-only просмотр и attach файла в черновик вставкой пути.

**Architecture:** Дерево листается новым `GET /api/files?path=` (ленивый per-dir, ignore-примитивы индексера, джейл как в `file-api`). Чтение — существующий `GET /api/file`. Attach — клиентская вставка относительного пути в бэктиках в черновик (нового канала вложений нет). Live — `IndexerModule.watch(onSettled)` → SSE `files` + `filesRevision`.

**Tech Stack:** Bun + TypeScript (backend), DOM/TS ES-модули (frontend), vitest (`bun test`), Biome + `tsc --noEmit` + `tsc -p tsconfig.frontend.json`.

**Spec:** [docs/specs/2026-10-07-webui-files-tab-design.md](../specs/2026-10-07-webui-files-tab-design.md)
**Branch:** `feat/webui-files-tab`

---

## Task 0: Contracts — types, i18n keys, version

**Files:**
- Modify: `src/core/host.ts` (`HostStateSnapshot`)
- Modify: `src/modules/webui/state.ts` (`WebUiState`)
- Modify: `src/modules/webui/host-state.ts` (`HostStateInput`, `buildHostState`)
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`

- [x] **Step 1:** Add `filesRevision?: number` to `HostStateSnapshot` (after `projectMap`), to `WebUiState`, and to `HostStateInput`; pass through in `buildHostState`.
- [x] **Step 2:** Add i18n keys (en+ru, parity): `web.sidebar.tab_files`, `web.files.empty`, `web.files.error`, `web.files.truncated`, `web.files.attach`, `web.files.open_failed`, `web.files.no_workspace`, `web.files.close`, `web.files.loading`.
- [x] **Step 3:** `bun test tests/i18n.test.ts` (parity guard) — expected PASS.

## Task 1: Shared workspace-path resolver

**Files:**
- Create: `src/modules/webui/file/paths.ts`
- Modify: `src/modules/webui/file/file-api.ts` (use the helper)
- Test: `tests/modules/webui/file-paths.test.ts`

- [x] **Step 1:** `paths.ts` exports `escapes(base,target)` and `resolveWorkspacePath(base, raw): Promise<{ok:true;absReal}|{ok:false;code:"outside_workspace"|"protected_path"|"not_found"}>` (lexical guard → `realpath` → guard → `matchProtectedPath`).
- [x] **Step 2:** Refactor `file-api.ts` to call `resolveWorkspacePath`; drop the local `escapes`/double-realpath. Behavior parity (`text/plain` errors). Run existing `tests/modules/webui/file-api.test.ts` — PASS.
- [x] **Step 3:** Unit test the resolver (escape `../`, absolute outside, symlink outside, protected `.env`, ok file).

## Task 2: `GET /api/files` directory listing

**Files:**
- Create: `src/modules/webui/file/files-api.ts`
- Modify: `src/modules/webui/server.ts` (register in `API_GROUPS`)
- Test: `tests/modules/webui/files-api.test.ts`

- [x] **Step 1:** `listDir(base, rel)` → `{ entries: {name,type,size?}[], truncated }`; dirs first then files, case-insensitive; ignores via `isIgnoredDirName`/`isIgnoredFileName`/`loadIgnoreMatcher`; cap `MAX_DIR_ENTRIES = 1000`.
- [x] **Step 2:** `handleFilesApi(req,res,reqUrl,s)` — JSON; `400 invalid_path`, `403 outside_workspace|protected_path`, `404 not_found`, `503 workspace_unavailable`; non-dir → 404.
- [x] **Step 3:** Register `handleFilesApi` in `API_GROUPS` (`server.ts:141`).
- [x] **Step 4:** Tests: sorting, ignore (`.gitignore`/`IGNORE_DIRS`), cap/truncated, jail, protected, non-dir, no-workspace.

## Task 3: Live notification

**Files:**
- Modify: `src/modules/indexer/module.ts` (`watch(onSettled?)`)
- Modify: `src/modules/webui/host-state.ts` (`WebIndexer.watch` signature)
- Modify: `src/modules/webui/index-watcher.ts` (`attachIndexWatcher(indexer, onChange?)`)
- Modify: `src/modules/webui/module.ts` (bump `filesRevision` + broadcast `files`)
- Test: `tests/modules/indexer/watch-settled.test.ts`

- [x] **Step 1:** `IndexerModule.watch(onSettled?)` calls `onSettled?.()` after the debounced `refresh()` (in `finally`).
- [x] **Step 2:** `WebIndexer.watch?(onSettled?)`, `WatchableIndexer.watch?(onSettled?)`, `attachIndexWatcher(indexer, onChange?)`.
- [x] **Step 3:** `module.ts`: pass callback → `state.filesRevision = (state.filesRevision ?? 0) + 1; broadcast({type:"files", ts, phase:"changed"}, state)`; pass `filesRevision: state.filesRevision` into `buildHostState`.
- [x] **Step 4:** Test: debounced refresh triggers `onSettled` once.

## Task 4: Frontend tab scaffold

**Files:**
- Modify: `src/modules/webui/assets/js/sidebar/state.ts` (`TABS`, `ICON_NAME`, `FilesView`, `sb.files`)
- Modify: `src/modules/webui/assets/js/sidebar/core.ts` (init refs, i18n, Escape)
- Modify: `src/modules/webui/assets/js/sidebar.ts` (barrel)
- Modify: `src/modules/webui/assets/index.html` (tab button + `#pane-files`)
- Modify: `src/modules/webui/assets/styles.css`

- [x] **Step 1:** `TABS = ["session","map","trace","lsp","files"]`; `ICON_NAME.files = "folder-tree"`; add `FilesView` + `sb.files`.
- [x] **Step 2:** `index.html`: fifth `.sb-tab` + `#pane-files` with `.files-tree`/`.files-detail`.
- [x] **Step 3:** `core.ts`: cache files DOM refs, wire close + Escape, call `renderFilesTree()` when the tab becomes effective.
- [x] **Step 4:** styles: `.files-tree`, `.frow`, `.frow.dir`, `.files-detail` (no boxes; STYLE.md).

## Task 5: Tree module (lazy listing)

**Files:**
- Create: `src/modules/webui/assets/js/sidebar/files.ts`
- Test: `tests/webui-files-dom.test.ts`

- [x] **Step 1:** `sidebarFilesState(host)` stores `workspace`, renders root lazily via `ensureListing("")`.
- [x] **Step 2:** `renderFilesTree()` walks `sb.files.listings` from `""`, recursing into `expanded` dirs; rows carry chevron + Lucide file/folder icon; click dir toggles+fetches; click file `openFile`.
- [x] **Step 3:** `sidebarFilesChanged()` invalidates `listings` for expanded dirs, refetches, reloads `selectedPath`.
- [x] **Step 4:** DOM test: expand fetches, caches, renders; empty dir message.

## Task 6: Viewer (read-only master-detail)

**Files:**
- Modify: `src/modules/webui/assets/js/sidebar/files.ts`

- [x] **Step 1:** `openFile(path)`: `.sb` gets `sb-expanded`; fill `#filesTitle`; `Escape`/`×` close.
- [x] **Step 2:** Fetch `/api/file?path=`. Image/PDF/media → `<img>`/`<embed src>`; `.md` → `renderMarkdown`; text → `<pre><code>` + hljs.
- [x] **Step 3:** Non-OK → localized `web.files.open_failed`.

## Task 7: Attach (insert path)

**Files:**
- Modify: `src/modules/webui/assets/js/session/composer.ts` (export `insertIntoDraft`)
- Modify: `src/modules/webui/assets/js/sidebar/files.ts` (row + header attach buttons)
- Modify: `src/modules/webui/assets/app.ts` (`initFiles({ insertPath })`)

- [x] **Step 1:** `composer.ts` exports `insertIntoDraft(text)`: insert at cursor in `#inp`, update `tab.draft`, `autogrow`, focus.
- [x] **Step 2:** `files.ts` row attach button + viewer header button call the injected `insertPath(relPath)` → `` `relpath` `` + trailing space.
- [x] **Step 3:** `app.ts`: import `insertIntoDraft`, `initFiles({ insertPath: (p) => insertIntoDraft("`"+p+"` ") })`.

## Task 8: Live wiring in app.ts

**Files:**
- Modify: `src/modules/webui/assets/app.ts`

- [x] **Step 1:** import `sidebarFilesState`, `sidebarFilesChanged`; call `sidebarFilesState(session.host)` in `renderState`.
- [x] **Step 2:** `es.addEventListener("files", ...)` → `sidebarFilesChanged()`; also refetch when `snapshot.filesRevision` changes in `renderState`.

## Task 9: Guards & docs

**Files:**
- Modify: `tests/webui-sidebar-dom.test.ts`, `tests/webui-assets.test.ts`
- Modify: `AGENTS.md`, `CHANGELOG.md`, `package.json` (2.23.0)

- [x] **Step 1:** update sidebar DOM test to 5 tabs (or tolerate); add asset guard strings for `files` tab.
- [x] **Step 2:** AGENTS.md — «WebUI Files Tab (2.23.0)» section; CHANGELOG `[2.23.0]`.
- [x] **Step 3:** full gate: `bun test`, `tsc --noEmit`, `tsc -p tsconfig.frontend.json`, `bun run quality`.

---

## Self-review

- **Spec coverage:** §4.1→T2; §4.2→T1; §4.3→T3; §5.1→T4/T5; §5.2→T6; §5.3→T7; §6→T0/T3; §7 edge→T2/T6; §8 i18n→T0; §9 tests→T1/T2/T3/T5/T9.
- **Placeholders:** none.
- **Type consistency:** `FileEntry{name,type,size?}`, `resolveWorkspacePath`, `insertIntoDraft`, `sidebarFilesState/Changed`, `filesRevision` used consistently.
