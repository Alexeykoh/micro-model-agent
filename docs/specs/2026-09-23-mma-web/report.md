# MMA Web — Autonomous Implementation Report

**Date:** 2026-09-23
**Branch:** `feat/mma-web` (not merged — awaiting your review; merge/PR is a manual-confirmation action)
**Version:** 2.3.0
**Spec:** [`design.md`](./design.md) · **Plans:** [`implementation-plan.md`](./implementation-plan.md), [`phase3-plan.md`](./phase3-plan.md) · **Mockup:** [`mockups/layout-v6.html`](./mockups/layout-v6.html)
**Gates at final commit:** `bun test` → 2420 pass, 2 skip, 0 fail · `tsc --noEmit` → clean

---

## Delivered (all phases)

**Phase 1 — Host seam.** `Host` interface (`src/core/host.ts`) extending the plugin-facing `HostBridge` with `executeCommand`/`getState`; `createHostBridge` moved to `core`; `Repl` and `WebHost` (`src/core/web-host.ts`) are two implementations over one `Agent`; plan projection helpers (`src/core/host-plan.ts`).

**Phase 2 — `mma web`.** CLI subcommand, headless bootstrap, SSE `GET /events` + REST, static assets, token/CSRF/caps, release 2.2.0.

**Phase 3 — UI parity + features.** Frontend rebuilt to the mockup; REST for config/sessions/models/history/memory/skills/plugins; session tabs + history load; slash commands; real usage metrics; tool output; plan card; image attachments; new-session creation; settings modal with 10 sections; dark/light/auto theme; docs/version 2.3.0.

**Phase 4 — Commands.** Extended web command set: `/help /status /config /model /provider /memory /reasoning /verbose /context /session list|use /export`; `/clear` + `/new` client-side.

**Phase 5 — Web questions.** `question`/`approve` re-registered **in web mode only** with a `PromptIO` over SSE (`question` event) + `POST /api/answer`; interactive UI in the feed.

**Phase 6 — Polish.** SSE reconnect/resync with a dim indicator; localization (`GET /api/i18n`, `web.*` keys, live switch); `Cache-Control: no-store` on assets; skip-safe Playwright smoke; bundling decision documented.

---

## Autonomous decisions (rationale)

1. **Plain JS frontend, no esbuild** (spec suggested TS+esbuild). The asset is a single zero-dependency file already copied into `dist/assets`; a bundler adds build tooling with no runtime benefit. Documented in `design.md` §Frontend.
2. **Command subset, not full REPL parity.** Commands needing `PromptIO`/terminal output (`/meet`, `/wizard`, `/init`, interactive prompts, `/provider add`) stay terminal-only. Implemented via a handler map (rule #17), so extending later is trivial.
3. **`question`/`approve` web-only.** They stay unregistered in the terminal (deliberate prior decision for small models); web registers them behind the PromptIO seam.
4. **`--no-agents-md` fix (global).** Commander exposes negatable options as `agentsMd` (default true); the code read `opts.noAgentsMd` (always undefined), so the flag never worked on **any** path. Fixed in `main.ts`.
5. **`/api/command` returns `202`** (was `200`) since output now streams via SSE; existing auth tests updated.
6. **`skipped` plan steps map to `done`** in `HostStateSnapshot` (the snapshot union is pending/in_progress/done/failed). Lossy but acceptable; noted.
7. **Static assets `no-store`** and re-read at server start — avoids stale UI confusion (the "spacing didn't change" report was a stale server process + browser cache).
8. **Tool result body added to `ToolEvent.output`** (`src/core/types.ts`) so live mode can show tool output; additive/optional.
9. **Version kept at 2.3.0** for all of Phases 3–6 (unreleased); Phase 4–6 items folded into the 2.3.0 changelog entry rather than bumping again.

---

## Open questions / needs your decision

1. **Merge strategy** — branch `feat/mma-web` is ready but not merged (needs your confirmation). A Phase-1-through-6 review pass before merge is advisable.
2. **`question` custom answers** — `allowCustom` is broadcast but the web UI doesn't render a "type your own" entry (options only). Implement if desired.
3. **`/export` from the browser** writes to the **server** filesystem and only shows the path; no download endpoint. A follow-up could stream the file over HTTP.
4. **Playwright smoke under Bun** — Bun ↔ Playwright pipe transport hangs, so the smoke only runs under Node/CI with a matching Chromium; under `bun test` it skips. Consider the repo's Node-bridge approach if browser CI coverage is wanted.
5. **MCP status** is config-derived (enabled/disabled), not live connection state (the MCP module exposes no runtime status).
6. **Multi-client / multi-tab live sessions** — the server supports multiple SSE clients but only one active turn; concurrent browser tabs share the active session. Confirm the intended semantics.

---

## Errors / problems encountered

- **Corrupted copies** of `design.md`/`layout-v5.html` when copying between branches with PowerShell `Set-Content` (lost newlines) — restored via `git checkout docs/mma-web-spec -- …`.
- **Concurrent agent** on the original branch edited `repl.ts`/`agent.ts`; paused and moved work to a fresh `feat/mma-web` branch from `master`.
- **300-line rule pressure**: repeatedly hit, resolved by extracting `util.ts`, `config-api.ts`, `sessions-api.ts`, `history-api.ts`, `settings-api.ts`, `answer-api.ts`, `i18n-api.ts`, `commands-shared.ts`, `commands-settings.ts`. Two pre-existing files remain over 300 (`src/core/agent/tool-batch.ts` 341, `src/config/registry.ts` ~391) — not introduced by this work.
- **Playwright browser version mismatch** (expects chromium 1243; installed ≤1234) — browser verification used static/skip-safe paths; earlier subagents that claimed browser checks may have relied on a different mechanism.
- **Stale server/assets** caused two false "not fixed" reports (spacing, then sessions) — resolved by restart + `no-store`.

---

## Known limitations / deferred

- Plan card refreshes only on `plan`/`todo` tool end (sidebar `/api/state` stays current).
- History restore doesn't render user-attached images (history entries don't carry them).
- The plan's original esbuild/TS frontend and a served partial-i18n split are superseded by the plain-JS + full-dict approach.
- Frontend has no jsdom/happy-dom harness; UI tests are source-level + HTTP-level.

---

## How to verify

```bash
bun run mma web --no-agents-md --no-open --port 3807   # → http://127.0.0.1:3807/
# Ctrl+F5; compare with docs/specs/2026-09-23-mma-web/mockups/layout-v6.html
```
