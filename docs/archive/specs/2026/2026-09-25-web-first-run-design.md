# MMA Web — First-Run Setup Wizard (design)

**Date:** 2026-09-25
**Branch:** `feat/web-first-run`
**Status:** Approved (design) — awaiting implementation plan
**Related:** [`2026-09-23-mma-web/design.md`](./2026-09-23-mma-web/design.md), [`2026-09-23-onboarding-meet-init-design.md`](./2026-09-23-onboarding-meet-init-design.md)

---

## 1. Problem

The terminal has a first-run wizard: `main.ts` detects a virgin config (no
`~/.mma/config.json` and no domain files) and runs `runSetup()` before the REPL
(`src/cli/main.ts:330`). `mma web` does not. `runWeb` computes the same `virgin`
flag but only prints `cli.first_run_oneshot` to stderr and boots with defaults
(`src/cli/web-command.ts:60,80`). The browser therefore receives an agent with
no configured provider/model — unusable, and the warning is invisible if the
terminal is scrolled away or the run is remote.

## 2. Goals / non-goals

**Goals**

- A browser setup wizard with parity to the terminal wizard: language, provider,
  discovery, API key, model, context window, max tool iterations, security.
- Chat is gated until setup completes (UI **and** server-enforced).
- After completion: persist config, apply it to the running process
  (`agent.reconfigure`), reload the SPA; the user lands in a working chat.
- One source of truth for setup logic shared by terminal and web.

**Non-goals**

- Re-running the wizard on an already-configured instance (use `mma setup`).
- The `meet` onboarding interview in the browser (separate scope; `/meet` stays
  terminal-only for now).
- Multi-provider/failover configuration in the wizard (Settings covers it).
- Native (Tauri/Electron) shells.

## 3. Architecture

### 3.1 Shared setup core — `src/modules/setup/`

Extracted from the terminal wizard so both frontends call the same code.
No terminal/UI dependencies, so the web server can import it.

| File | Contents |
| --- | --- |
| `answers.ts` | `SetupAnswers` interface, `SETUP_LANGUAGES`, `SETUP_DEFAULTS` (`contextWindow: 32768`, `maxToolIterations: 1000`). |
| `apply.ts` | `applyAnswersToConfig(config, answers)` + `SECURITY_BASH_BLOCKLIST` (moved verbatim from `src/cli/setup-order.ts`). |
| `discovery.ts` | `scanLocalServers()`, `fetchProviderModels(baseUrl, apiKey)`, `testProviderChat(baseUrl, apiKey, model)` (moved from `src/cli/setup.ts`). |

Compatibility shims (no behavior change, keeps existing import paths and tests):
`src/cli/setup-order.ts` re-exports `applyAnswersToConfig`; `src/cli/setup.ts`
re-exports `SetupAnswers` and uses `discovery.ts`. `tests/cli/main-first-run.test.ts`
stays untouched.

### 3.2 Server — new `src/modules/webui/setup-api.ts`

Pure handlers over `WebUiState`, following the existing `*-api.ts` split
(`config-api.ts`, `providers-api.ts`). Auth + same-origin are already enforced
upstream in `server.ts`.

`WebUiState` gains:

- `setupRequired: boolean` — set from the bootstrap-time `virgin` flag, cleared
  on successful `POST /api/setup`.
- `setup?: { languages; providers; defaults }` — display data resolved by
  `module.ts` (languages/defaults from `modules/setup`, provider list from
  `BUILTIN_PROVIDERS`/`HOSTED_BASE_URLS`).

### 3.3 Frontend

- `index.html`: a hidden full-screen gate `<div id="setupGate">` plus
  `<script src="/setup.js"></script>`.
- `setup.js` (new static asset): fetches `GET /api/setup`; when `required`, it
  renders the wizard into the gate, hides the composer/commands, and on success
  does `location.reload()`. `app.js` only calls `window.MmaSetup?.maybeOpen()`.
- The wizard is a full-screen page (no overlay over a dead chat). It follows
  `docs/design/ui/STYLE.md`: rows, glyphs, no boxed panels; semantic colors.

Wizard steps:

1. **Language** — English / Русский. Selection calls `POST /api/setup/locale`
   and re-fetches `/api/i18n`, so the rest of the wizard is localized
   immediately (mirrors the terminal wizard switching locale first).
2. **Provider** — `BUILTIN_PROVIDERS` list plus a "openai-compat / local"
   branch with a **Scan** action (`POST /api/setup/scan`) and a custom URL field.
3. **API key** — optional for local; required-ish for hosted (default from the
   provider preset).
4. **Model** — `POST /api/setup/models` populates a list; free-text fallback
   when the provider returns nothing.
5. **Context & iterations** — numeric fields with `SETUP_DEFAULTS`.
6. **Security** — bash block / dangerous flags / restrict paths toggles
   (same semantics as `applyAnswersToConfig`).
7. **Review & finish** — summary from the answers; `POST /api/setup` with the
   full payload; show `persisted` / `warning`; reload.

### 3.4 Gating (defense in depth)

- UI: `setup.js` hides the chat while `required`.
- Server: while `state.setupRequired` is true,
  - `POST /api/message` → `409 { error: "setup_required" }`;
  - `POST /api/command` → `409 { error: "setup_required" }`.
- Still allowed: `/events`, static assets, `/api/state`, `/api/i18n`,
  `/api/setup*`.
- Implemented in `handleMessagePost` (`webui/util.ts:203`) and the
  `/api/command` branch (`webui/server.ts:156`) so a direct curl or a second
  tab cannot bypass the UI.

## 4. Data flow

```
runWeb (virgin) ──setupRequired──▶ WebUiState ──▶ GET /api/setup (required:true)
                                        │
browser ──app.js load──▶ setup.js ─────┘
   │  scan/models/test/locale (setup-api)
   │
   └─ POST /api/setup {answers}
           │
           ├─ validate (shape/enums/ints)
           ├─ applyAnswersToConfig(config, answers)
           ├─ setLocale(config.locale)
           ├─ saveConfig(config, ~/.mma/config.json)
           ├─ await reconfigure(config)        // agent hot-swap
           ├─ state.setupRequired = false
           ├─ broadcast SSE { type:"setup_done" }
           └─ 200 { ok, persisted, warning? }
   │
   └─ location.reload()  ──▶ normal chat, configured provider
```

## 5. API contracts

All requests pass the existing token/same-origin checks; bodies use
`readBody` + `readBodyError` (413-safe).

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/setup` | — | `{ required, languages: [{value,label}], providers: [{type,label,baseUrl?}], defaults: {contextWindow,maxToolIterations} }` |
| POST | `/api/setup/scan` | — | `{ servers: [{label,url}] }` |
| POST | `/api/setup/models` | `{baseUrl, apiKey}` | `{ models: string[] }` |
| POST | `/api/setup/test` | `{baseUrl, apiKey, model}` | `{ ok: boolean }` |
| POST | `/api/setup/locale` | `{locale}` | `{ ok: true, dicts }` (process i18n only; not persisted) |
| POST | `/api/setup` | `SetupAnswers` | `200 {ok:true, persisted:boolean, warning?}` / `400 {ok:false,error}` / `409 {error:"already_configured"}` when not required |

Validation on `POST /api/setup` mirrors `SetupAnswers`: non-empty `provider`,
`apiBase`, `model`; positive integers for `contextWindow` /
`maxToolIterations`; `locale ∈ SETUP_LANGUAGES`; booleans for the security
flags. Invalid → `400`, config untouched.

## 6. Security

- The wizard writes to the global config only — same trust boundary as
  `/api/config` and `/api/providers`.
- Non-loopback binds still require a token (`server.ts` unchanged); the setup
  endpoints require the same auth as every other `/api/*` route.
- `apiKey` is accepted but **never echoed** back; the review step shows a masked
  value. No secrets in SSE/logs (`scrubError`/redaction already used).
- `POST /api/setup` refuses (`409 already_configured`) after completion to
  avoid silent reconfiguration races.

## 7. i18n & style

- New keys `web.setup.*` (titles, step labels, buttons, hints, errors) in both
  `src/i18n/en.json` and `src/i18n/ru.json`.
- RU pluralization for counted lists (servers/models) via the existing
  `pluralCount` conventions where needed.
- Visual language per `docs/design/ui/STYLE.md`: `◇` action glyph, `✓`/`⚠`/`✗`
  semantic colors, dim separators; no emoji tool icons; no boxed panels.

## 8. Testing

- `tests/webui/setup-api.test.ts`:
  - `GET /api/setup` reports `required` and display data;
  - `POST /api/setup` validates, applies (`applyAnswersToConfig`), persists,
    reconfigures, flips `setupRequired`, broadcasts `setup_done`;
  - `POST /api/setup` on a configured state → `409`;
  - `POST /api/message` and `/api/command` → `409 setup_required` while gated.
- Source-level asset test: `index.html` contains the gate + `/setup.js`;
  `setup.js` references `/api/setup` endpoints (mirrors existing webui asset
  tests; no jsdom harness).
- `tests/cli/main-first-run.test.ts` unchanged → shared `apply` refactor is
  behavior-preserving.
- Gates: `bun test` green, `tsc --noEmit` clean.

## 9. Files touched

**New:** `src/modules/setup/{answers,apply,discovery}.ts`,
`src/modules/webui/setup-api.ts`, `src/modules/webui/assets/setup.js`,
`tests/webui/setup-api.test.ts`, this spec.

**Changed:** `src/cli/setup.ts`, `src/cli/setup-order.ts`,
`src/cli/web-command.ts`, `src/modules/webui/{state,server,util,module,assets}.ts`,
`src/modules/webui/assets/{index.html,styles.css,app.js}`,
`src/i18n/{en,ru}.json`, `AGENTS.md`, `CHANGELOG.md`, `package.json`.

## 10. Three-dimension check (AGENTS.md)

- **Real user:** browser-first onboarding, localized, immediate feedback
  (scan/test/persist warnings), lands in working chat after reload.
- **Small model:** nothing enters the model context until the provider exists;
  gating prevents a doomed first turn on a default/unreachable endpoint; no
  prompt/tool changes.
- **Adjacent systems:** reuses `applyAnswersToConfig` (single write path),
  `saveConfig`, `reconfigure`; no `LLMProvider`/plugin/`session.jsonl` contract
  changes; additive `/api/setup*` only; existing webui endpoints untouched.

## 11. Versioning

MINOR release **2.6.0** (new subcommand behavior, new endpoints/assets,
additive). CHANGELOG under `### Added`. No breaking changes, no alias needed.
