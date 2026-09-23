# MMA Web Mode — Design Spec

**Date:** 2026-09-23
**Status:** approved design (brainstorming), awaiting implementation plan
**Canonical mockup:** [`mockups/layout-v6.html`](./mockups/layout-v6.html) — open in a browser; interactive (dropdowns, settings modal, theme, collapsible sections, working input).
**Style source:** [`docs/design/ui/STYLE.md`](../../design/ui/STYLE.md) — chat glyphs, color roles, quiet-by-default rules apply unchanged.

## Goal

A first-class web mode `mma web` that runs the agent **without a TTY**, as a full alternative to the terminal REPL — same agent, same config, same sessions, two renderers (terminal + browser).

Start-up path is phased: core lands as a supported mode alongside the REPL; nothing in the design assumes a terminal is also running.

## Non-goals

- No multi-user / remote-auth product (token-on-non-loopback only).
- No WebSocket (SSE only — matches prior web-ui decisions).
- No framework SPA: zero-runtime plain JS served verbatim, CSS variables for themes.
- No change to `session.jsonl` schema, `--json` machine contract, or STYLE.md glyph vocabulary.
- Terminal REPL remains fully supported and unchanged in behavior.

## Architecture

```
mma web [--port N] [--host H] [--no-open] [--token T]
        │
        ▼
bootstrap()  →  Agent + modules (identical to REPL path)
        │
        ▼
WebHost (new: src/core/web-host.ts)
  · implements Host interface (see below)
  · PromptIO — web impl: pending question → SSE event → POST /api/answer
  · OutputChannel stays quiet (no TTY); no LineEditor
        │
        ▼
WebUiModule (new: src/modules/webui/)
  · server.ts — node:http: SSE /events + REST /api/* + static assets
  · app creation separated from listen() (architecture rule #13)
  · token required when bind host ≠ 127.0.0.1
```

### Host interface (shared seam)

Today `Repl` owns `createHostBridge` (`src/cli/repl.ts`). Design: extract a **Host** interface next to the existing `HostBridge` in `src/modules/types.ts`:

```ts
interface Host {
  isBusy(): boolean;
  submit(text: string, opts?: { images?: string[] }): Promise<void>;
  interrupt(): void;
  executeCommand(line: string): Promise<void>;   // slash-command handler map
  subscribeOutput(fn: (ev: OutputEvent) => void): () => void;
  getState(): HostStateSnapshot;                 // plan, usage, session, model…
}
```

- `ReplHost` — wraps existing `runAgent` / `Repl.commands` (rule #17 handler map).
- `WebHost` — same capabilities; wires `PromptIO` to the web question flow.

Both hosts run against a single `Agent` instance **per process**. Terminal and web are separate processes (separate sessions if run simultaneously) — no cross-process locking.

### Commands and settings over HTTP

- `POST /api/command {line}` → `Host.executeCommand` — free access to `/config`, `/model use`, `/provider use`, `/resume`, `/export`, `/status`, … (no command re-implementation).
- `GET /api/config` → `configForDisplay()` (redacted; `--show-secrets` equivalent only via explicit flag later).
- Config writes go through the registry (`src/config/registry.ts`) + `saveConfig` + `agent.reconfigure()` when `reconfigure: true` — one write path shared with REPL (`mutateConfig`).

## Wire contract

### SSE `GET /events`

Server-sent events, coalesced client-side where needed (text/meta ~350ms, as in `examples/plugins/web-ui`).

| event | payload (JSON) | source |
| --- | --- | --- |
| `phase` | `{phase: "thinking"\|"done"}` | `onPhase` |
| `text` | `{chunk}` | `onChunk` / `onText` |
| `meta` | `{chunk}` | `onMeta` |
| `tool_start` | `{tool, args}` (friendly label resolved server-side or client via `tool.friendly.*`) | `onTool` / `onToolStart` |
| `tool_end` | `{tool, args, durationMs, error?, images?, detail?}` | `onTool` / `onToolEnd` |
| `question` | `{id, text, options?}` | web PromptIO pending |
| `turn_end` | `TurnSummary` | `onTurnEnd` |
| `plan` | checklist snapshot | `execModule.getActivePlan()` on plan/todo tool-end + poll fallback 2s |
| `usage` | `{contextUsed, contextLimit, cost, cache, compactions, quality, …}` | `AgentResult` / context bar source |
| `session` | meta (id, name, model, …) | SessionManager |
| `output` | `OutputEvent` (warn/error) | `subscribeOutput` |
| `config` | redacted snapshot after any change | after `mutateConfig` |

Reconnect: browser retries with backoff; on reconnect issues `GET /api/state` for full resync.

### REST

| endpoint | method | purpose |
| --- | --- | --- |
| `/api/state` | GET | full snapshot: history tail, plan, usage, session, config display, models list, providers |
| `/api/message` | POST | `{text, images[]}` → `Host.submit`; 409 busy |
| `/api/interrupt` | POST | `Host.interrupt` |
| `/api/command` | POST | `{line}` → slash-command map |
| `/api/answer` | POST | `{id, value}` → resolve pending PromptIO question |
| `/api/config` | GET | redacted config + registry metadata (keys, enums, valueTypes) for settings UI |
| `/api/config` | POST | `{key, value}` → `mutateConfig` path |
| `/api/sessions` | GET | list; `/api/sessions/:id` GET/DELETE; activate |
| `/api/models` | GET | model cache (`knownModels` / refresh) |
| `/` `/app.js` `/styles.css` | GET | static assets |

Security (inherited from proven `examples/plugins/web-ui` design):

- bind `127.0.0.1` by default; non-loopback **requires** token (`MMA_WEBUI_TOKEN` or `--token`)
- same-origin check on POST, body size cap, SSE client cap, rate limit
- secrets scrubbed from SSE payloads

## Frontend

**Stack:** no framework, plain JavaScript (`assets/app.js`) served verbatim; CSS custom properties for themes; static assets copied by `copy-assets` in `build:prod`. Target: instant load, no runtime deps.

**Implementation note (bundling decision):** the original sketch proposed a TypeScript frontend bundled with esbuild. The shipped implementation is **plain zero-dependency JS, no bundler**. Rationale: the browser asset is already the single shipped file (`assets/app.js`), it has no framework or runtime dependencies to resolve, and `scripts/copy-assets.ts` copies it verbatim into `dist/assets` for the bundle. A bundler would add build tooling and a source map/transpile step with no runtime benefit, so none is used. `app.js` is the canonical source and the served artifact (no generated intermediate).

**Layout (canonical: `mockups/layout-v6.html`):**

```
┌ topbar: [+] [⚙] [☰] │ session tabs (switch/close) ──────────┐
├──────────────────────────────────────┬────────────────────────┤
│ chat feed (scroll)                  │ sidebar (right)        │
│  start banner, messages, tools,     │  ▾ plan (large,        │
│  reasoning, cards, metrics          │    own scroll)         │
│                                      │  ▾ session · usage     │
│  selectors: model / provider /      │  (context, cache, cost,│
│              context dropdowns      │   compactions, quality)│
│  [textarea input]                   │                        │
└──────────────────────────────────────┴────────────────────────┘
```

- **Topbar:** `+` (new chat), `⚙` (settings), `☰` (all sessions) are compact icon buttons.
  **Session tabs** follow `☰`: each tab shows the session name + short id, the active tab is
  highlighted, `✕` closes it; `+` opens a fresh "new chat" tab, and picking a session from `☰`
  opens it as a tab. Switching tabs preserves per-tab content.

**Chat rendering (from STYLE.md):**

- user message: blue accent block, left border, `>` prefix — visually distinct from agent output
- agent answer: dimmer body text; actions as `◇` colored by category; metrics `⟡` once per turn
- reasoning: low-contrast violet header + near-chrome body; click toggles hide/show
- tool payload cards: image, file, link, plan block, code, grouped run `│ N actions ✓`
- error: one `✗` line + at most one `↳` hint; warnings yellow (`⚠`), never red for soft guards
- busy: `✦ думаю · Ns · Esc — stop`; slash commands render as user block + dim output

**Sidebar:** sections are independently collapsible and independently scrollable on overflow; plan section takes remaining vertical space. No model/memory/plugins lists in sidebar — those live in Settings.

**Settings modal:** wide dialog, left menu + right content: General, Model & Provider, Context, Reasoning, UI & Theme, Memory, Skills, Plugins · MCP, Security, Advanced. Reads/writes via `GET/POST /api/config` (registry metadata drives controls). Theme switcher lives here (dark/light/auto).

**i18n:** frontend strings through a served dict of `t()` keys (en+ru parity, rule #8) — phase 1 may ship en+ru hardcoded map exported from `src/i18n`; chat content itself already localized server-side (`tool.friendly.*` resolved before `tool_start` events, or sent raw and mapped client-side — prefer server-side).

## Error handling

| case | behavior |
| --- | --- |
| submit while busy | 409 → inline status, input stays enabled after turn_end |
| no host bridge / agent not ready | 503 → banner with retry |
| bad/missing token | 401 → login hint (token in URL or header) |
| SSE drop | auto-reconnect + `/api/state` resync |
| tool failure | normal chat error line (`✗` + hint), no raw recovery directives (STYLE.md) |
| question timeout / session end | pending question resolves as cancel |

## Testing

- **Contract:** extend pattern of `tests/web-ui-server.test.ts` — REST status codes, SSE payload shapes, token/CSRF/rate limits, app≠listen unit tests.
- **Host seam:** `WebHost.submit/interrupt/executeCommand` unit tests with fake Agent.
- **Config panel:** `GET /api/config` redaction; `POST` delegates to registry validation.
- **Frontend:** smoke via existing `_testing` pattern or Playwright (already a dependency) — load page, send message, receive mocked SSE.
- **Gates:** `bun test` + `tsc --noEmit`; AST `no-direct-console` rule respected (server logs via OutputBus).
- **Cert:** one interactive cert scenario driving `mma web` headless (CI: token + curl SSE).

## Implementation phasing

1. **Seam extraction** — `Host` interface; move `createHostBridge` out of `Repl` into shared module; `Repl` becomes `ReplHost` (no behavior change; green tests).
2. **WebUiModule + `mma web`** — server (SSE/REST/static), `WebHost`, headless entry, auth. Chat-only UI (transcript + input + interrupt) matching STYLE.md.
3. **Sidebar + selectors** — plan/usage/sessions panes; model/provider/context dropdowns → `/api/config`.
4. **Settings modal** — full registry-driven panel; theme; memory/skills/plugins pages.
5. **Interactive reasoning + questions** — collapse toggles; web PromptIO (`question`/`approve` re-registered behind this seam when enabled).
6. **Polish** — i18n dict, reconnect/resync, Playwright smoke, docs (`AGENTS.md`, `docs/agents/*`), CHANGELOG.

Each phase: branch `feat/mma-web-<phase>`, green `bun test` + `tsc`, merge to master.

## Open questions (deferred, non-blocking)

- Should `question`/`approve` tools be re-registered globally or only when a web host (or REPL) explicitly installs PromptIO? (Current: unregistered — `tools/index.ts`.)
- Distribution: ship static assets inside npm package (`files[]`) — almost certainly yes; confirm with `build:prod` size.
- Whether one process can attach **both** a terminal REPL and a web server later (out of scope for v1; Host seam keeps the door open).
