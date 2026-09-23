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

## Task C — Memory + skills/plugins pages (settings)

Wire the settings sections to real data:
- **Memory**: list / add / forget entries (the `MemoryStore` is already exposed via `BootstrapResult.memoryStore` → `WebUiState.memory`).
- **Skills**: list loaded skills (name, source, enabled) from `SkillsModule`.
- **Plugins · MCP**: list plugins (name, source, version) and MCP servers (name, status).
- Endpoints: `GET /api/memory`, `POST /api/memory` (add), `DELETE /api/memory/:category/:n` (forget); `GET /api/skills`; `GET /api/plugins` (MCP merged). Authed + same-origin; missing collaborator → 503, never crash.

## Task D — Chat cards + questions

- Render the **plan block** card in the feed when a `plan`/`todo` tool runs (matching the mockup).
- Render a `?` **question** block when the web PromptIO lands (Phase 5); until then render nothing or a dim placeholder.
- Ensure file/link/image/code cards render from real data where available.

## Task F — Usage metrics in the sidebar

Populate `HostStateSnapshot` (`contextUsed/contextLimit/costUsd/compactionCount/cache`) from `AgentResult`/context snapshot after a turn; limit from `config.contextWindow`. Frontend renders them (no more `—` when data exists).

## Task G — Tool output in `tool_end`

Include a clipped tool result body (`output`, capped per tool) in the `tool_end` SSE event; render it as a code/detail block in the feed so live bash/file output is visible.

## Task H — New-session creation

- Backend: `POST /api/sessions` → `sessionManager.create(name?)` returning the meta.
- Frontend: `+ new chat` creates a server session and opens it as a tab.

## Task I — Config registry min/max

Include numeric `min`/`max`/`step` in `GET /api/config` registry entries so numeric inputs render bounds.

## Task J — Image attachments from the browser

Frontend: attach images (paste/drag/file input) → send as `images[]` data URLs (already supported by `/api/message`), respecting caps (≤3, ≤6MB each) with a dim error on violation.

## Task K — Docs, changelog, version

- Update `docs/agents/modules.md` with the new endpoints and the supported command subset.
- CHANGELOG entry + MINOR version bump per `docs/agents/versioning.md`; update `AGENTS.md` "Current Version" and synced version refs.
- Add `.superpowers/` to `.gitignore`.

## Task E — Slash-command execution from the browser

`/api/command` is currently a documented no-op. Make slash commands actually run in web mode.

- New `src/modules/webui/commands.ts`: `makeWebCommands(deps)` returns `(line) => Promise<void>`, reusing the **same** config/session machinery as the REPL (config registry `setConfigValue`/`getConfigValue`, `saveConfig`, `agent.reconfigure`, session manager, memory module). Supported subset (extensible via a handler map, rule #17):
  - `/help` — list available commands
  - `/status` — model · provider · context · session · verbosity
  - `/config <key> [value]` — read/write via the registry (mirrors the settings panel)
  - `/model use <name>`, `/model list`
  - `/provider use <name>`, `/provider list`
  - `/memory` (overview) / `get` / `set` / `unset` / `find` / `forget` where the memory module allows
  - `/clear` (client-side screen clear), `/new` (new chat tab) — handled by the frontend, no server round-trip
- Output is emitted over SSE as a `command` event (`{ text }`) and rendered as dim lines in the feed; `/api/command` returns `{ ok, error? }` (202) and the output streams via SSE (keeps the HTTP contract simple).
- `WebHost.executeCommand` delegates to this dispatcher. Unknown command → a dim `↳ unknown command` line (never a raw error).
- **Non-goals:** commands that need terminal-only context (e.g. `/meet`, interactive prompts) stay terminal-only; document which subset is supported.

**Status (implemented):** `src/modules/webui/commands.ts` (`makeWebCommands`) runs `/help`, `/status`, `/config`, `/model`, `/provider`, `/memory` through a handler map; output streams as SSE `command` events (`{type,ts,text}`, secrets redacted) and `/api/command` answers `202 {ok:true}`. `/clear` and `/new` are handled browser-side (`assets/app.js`). `/memory` is backed by the shared `MemoryStore` exposed on `BootstrapResult.memoryStore` and wired through `WebUiDeps.memory`. Terminal-only commands remain out of scope.

## Verify (all tasks)
- `bun test` + `tsc --noEmit` green.
- Manual: `bun run mma web --no-open --port 3807`; compare side-by-side with the mockup; check tabs, selectors, settings, theme, reasoning toggle, plan scroll.
