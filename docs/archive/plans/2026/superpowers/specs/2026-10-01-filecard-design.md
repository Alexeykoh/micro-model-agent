# Filecard Redesign — D (quiet line) + E (grouping)

Date: 2026-10-01 · Branch: `feat/filecard-redesign` · Status: approved design, awaits implementation plan
Mockups: `.superpowers/brainstorm/filecard/content/filecard-v3-recommended.html` (server http://localhost:56367)

## 1. Problem

Web feed renders one boxed `.filecard` per file-tool call (`feed.js cardFor()`):
`surface` background + `1px border-2` + `radius 6px`, two rows, three pill buttons
(Open / Download / Copy-path). It is the only boxed element in the feed, so it
visually pops out and contradicts `docs/design/ui/STYLE.md` ("No boxes, no panels —
only lines, indentation and glyphs"). Buttons are near-dead actions (open duplicates
a path click, download is ~yearly, copy-path is faster from text), and the
format/drawio badge is niche (matters only to highlighting/viewer).

## 2. Decision

Replace the card with a quiet terminal-style action line (variant D).
Consecutive file lines collapse into a grouped summary (variant E).
No new icons, no new colors, no boxed panels.

- D — `◇ <friendly label> · <path-link> [copy-icon] <status>` — one line, same
  language as REPL and the rest of the feed.
- E — `│ N files ✓ [chevron-down]` + expandable `↳ basename` list — only when
  2+ file actions land in one turn in a row.

Rejected: B (still a box), C (loses tool context read vs write), F alone (drops the
viewer link), G alone (hides affordance; hover behavior is folded into D instead).

## 3. UX spec

### 3.1 D — anatomy (single line, `div.filerow`)

```
◇ Чтение файла · src/modules/webui/…/feed.js [copy-icon] ✓
```

- `◇` + friendly label (`tool.friendly.*` via `labelOf()`) share the category
  color: cyan recon (`read_file`, `list_dir`, `file_info`), magenta mutate
  (`write_file`, `edit_file`, `delete_file`, `move_file`). Separator `·` dim.
- Path: dim accent link to `/api/file?path=<enc>` (`target=_blank`,
  `rel=noopener noreferrer`), full path in `title`, `overflow-wrap:anywhere`.
  Click = open in viewer. Non-openable tools (`list_dir`, `delete_file`,
  `move_file`) render the path as plain dim text (no link, file is gone/dir).
- Copy: Lucide `copy` icon-only button, visible on hover/focus (always visible on
  touch, `pointer: coarse`), `aria-label` from `web.card.copy_title`. Success swaps
  to `check` for 1.4s, failure keeps `copy` + `⚠` status (no text pill swap).
- Status tail: `✓` / `✗` / `⚠` text glyph (existing tool-status flow), no new color.
- drawio/format: NO badge. `.drawio` hint becomes a `↳`-detail visible only in
  `verbose` (same gate as other `kind:"tool"` meta). Format detection stays
  silent (viewer/highlight only).
- No Download button. Download stays available inside the file viewer page, not
  in the feed.

### 3.2 E — grouping (consecutive file rows, same turn)

- Trigger: 2+ `filerow`s appended consecutively without an intervening assistant
  text/tool of another kind. Render one summary row:
  `│ N files ✓ [chevron-down]` (count + combined status: `✗` if any failed else `⚠` if any warned else `✓`).
- Expand (click / Enter / Space on the chevron button): `↳`-list of basenames,
  each a link when openable, dim tail path (`↳ feed.js · src/…/js/`). Collapse
  toggles back. `aria-expanded` on the button. State is per-turn, not persisted.
- Single file action never groups. Mixed tool kinds break the group.

### 3.3 States, a11y, i18n

- Hover/focus: copy icon and chevron get `:focus-visible` outline (accent).
  `prefers-reduced-motion`: no transitions on icon swap/expand.
- Long paths wrap (`anywhere`), row never overflows 480px feed measure.
- i18n: reuse `tool.friendly.*`, `web.code.copied/copy_failed`, `web.card.open_title`
  (as link title), `web.card.copy_title`. Drop `web.card.open/download/copy_path`
  button labels (keep keys as deprecated aliases for one release or remove with
  test update — plan decides; default: remove + update tests).
- Mobile: copy icon always opaque (no hover dependency); path tap opens viewer.

## 4. Technical design

- `src/modules/webui/assets/js/feed.js` — rewrite `cardFor()` file branch:
  emit `div.filerow` (D) instead of `div.filecard`; append status via existing
  tool-status path; group consecutive rows (E) with a small local grouper in
  `appendTo` scope (no session/state changes). Use `icon("copy")` / `icon("check")`
  from `dom.js` and `chevron-down` for the group toggle. Keep `safeUrl` + no-token
  invariant (`/api/file` links carry no auth token; cookie auth covers navigation).
- `src/modules/webui/assets/styles.css` — delete `.filecard*` rules; add minimal
  `.filerow` (flex, baseline, gap 8px, `margin-left:26px`, `font-size:12.5px`,
  link accent, dim tail) + `.filerow .copy-btn` (icon-only, hover/focus opacity)
  + `.filegroup` summary + `↳` list. No backgrounds, no borders, no pills.
- `src/modules/webui/assets/js/format.js` — no taxonomy change (`FILE_TOOLS`,
  `OPENABLE_TOOLS` stay). `labelOf()` stays the label source.
- Allowed visuals only: Lucide set from `dom.js` (`copy`, `check`,
  `chevron-down`, `chevron-right`) + STYLE.md text glyphs
  (`◇ ✓ ✗ ⚠ ↳ │`). No emoji, no new SVG, no per-extension icons.
- Backward compat: old `.filecard` DOM never persisted (feed is re-rendered per
  load), so no migration. E2E `web-commands`/`web-chat-tabs` unaffected (no
  slash-command change).

## 5. Data flow

`tool_end(file-tool)` → `cardFor()` → D row (`<a /api/file>` when openable) →
consecutive-row grouper → E summary when 2+ in a row. Viewer (`GET /api/file`)
unchanged. Copy uses existing `copyText()` (clipboard + execCommand fallback).

## 6. Error handling

- Missing `path` arg → no row (as today, `return null`).
- Viewer 404/unreadable → existing viewer error page; feed row keeps `⚠`.
- Clipboard denial → `⚠` + keep `copy` icon (no text change).
- Fail-open: grouping never drops rows — on any grouper error, render plain D rows.

## 7. Testing

- Update `tests/webui-assets.test.ts`: drop `.filecard/.fc-open/.fc-actions/.fc-hint`
  + `download=1`/`web.card.download` assertions; assert `.filerow`,
  `icon("copy")`/`icon("check")`, `/api/file` link with `_blank` + `noopener`,
  no `&token=`, `chevron-down` group toggle, verbose-gated drawio `↳`.
- Update `tests/webui-smoke.test.ts` `filecard` fixture → `filerow`.
- Manual: `mma web` → read/write/list/delete + 3×reads in one turn (group),
  keyboard-only expand, touch emulation, `verbose quiet` hides drawio `↳`.
- E2E: extend `tests/e2e/web-chat-tabs` with one file-row + group case (plan scope).

## 8. Non-goals

No new file-type icons, no preview thumbnails, no download-in-feed, no sorting/
filtering, no persisted group state, no `--json`/session schema change, no REPL
change (REPL already quiet-line).
