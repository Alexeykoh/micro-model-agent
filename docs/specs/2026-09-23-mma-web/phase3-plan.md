# MMA Web — Phase 3 Plan: Visual parity with the approved mockup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Bring `mma web` up to the approved UI — [`mockups/layout-v6.html`](./mockups/layout-v6.html) is the **canonical target** (structure, spacing, colors, glyphs, interactions). The current Phase-2 frontend is a placeholder and must be replaced.

**Reference:** spec [`design.md`](./design.md) §Frontend; style [`docs/design/ui/STYLE.md`](../../design/ui/STYLE.md). The mockup is authoritative where they differ.

**Non-goals:** real slash-command dispatch (still Phase 4), esbuild bundling, multi-user.

---

## Task A — Config/session/model REST endpoints

**Files:** `src/modules/webui/server.ts` (+ `util.ts`), `tests/webui-config.test.ts`

- `GET /api/config` → `{ config: redactConfigSecrets(config), registry: [{key, aliases, valueType, enum?, group}] }` using `src/config/registry.ts` (`configDefs`, `allConfigNames`, `formatConfigValue`) and `src/config/redact.ts`.
- `POST /api/config {key, value}` → `setConfigValue(config, key, value)`; on ok `saveConfig`; if `result.reconfigure` call the host's reconfigure hook (add to `Host`/`WebHost` deps). Return `{ok, value?, error?}`.
- `GET /api/sessions` → `sessionManager.list()`; `POST /api/sessions/activate {id}` → `setActive`; `DELETE /api/sessions/:id` → `delete`.
- `GET /api/models` → host `knownModels()` (add to host deps).
- All authed + same-origin.

## Task B — Frontend rewrite to the mockup

**Files:** replace `src/modules/webui/assets/{index.html,styles.css,app.js}`

Faithfully reproduce `mockups/layout-v6.html`:
- topbar: `+` (new chat), `☰` (all sessions dropdown), session **tabs** (switch/close), `⚙` right; tabs scrollable with styled scrollbar.
- chat feed: start banner, user message = blue accent block with `>`, agent text dimmer, tool lines `◇` colored by category, `↳` details, `⟡` metrics, `⚠`/`✗`, reasoning `✦` with hide/show toggle, cards (plan/file/link/image), `/command` output.
- selectors above the input: **model / provider / context** dropdowns (from `/api/config` + `/api/models`).
- right sidebar: independently collapsible + independently scrollable sections; large scrollable **plan** with progress bar; session·usage (context/cache/cost/compactions/quality).
- **⚙ settings modal**: wide popup, left menu + right content (General, Model & Provider, Context, Reasoning, UI & Theme, Memory, Skills, Plugins·MCP, Security, Advanced) wired to `/api/config`; theme dark/light/auto.
- dark/light via CSS variables; lighten-dark palette matching the mockup.
- zero-dependency vanilla JS; `textContent` for model/tool output (no XSS).

## Task C — Memory + skills/plugins pages

Wire settings sections to real data: memory (list/add/forget via existing memory module/tools), skills registry, plugins/MCP status.

## Task D — Chat cards + questions

Render tool payload cards from `tool_end` (image/file/link/plan), and a `?` question block when the web PromptIO lands (Phase 5).

## Verify (all tasks)
- `bun test` + `tsc --noEmit` green.
- Manual: `bun run mma web --no-open --port 3807`; compare side-by-side with the mockup; check tabs, selectors, settings, theme, reasoning toggle, plan scroll.
