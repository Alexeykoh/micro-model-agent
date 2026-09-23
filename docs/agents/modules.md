# Modules

## Session Management

Sessions persist conversation history to `~/.mma/sessions/<id>/` as `meta.json`, `history.jsonl`, and `session.jsonl`.

### REPL slash commands

| Command              | Aliases           | Description                  |
| -------------------- | ----------------- | ---------------------------- |
| `/sessions`          | `/ls`             | List all sessions (* active) |
| `/new <name>`        | `/create`         | Create a new session         |
| `/resume <id\|name>` | `/switch`, `/use` | Switch to a session          |
| `/rename <name>`     |                   | Rename current session       |
| `/delete <id>`       | `/rm`             | Delete a session             |

### REPL Keybindings

| Key         | Context            | Action                                                    |
| ----------- | ------------------ | --------------------------------------------------------- |
| `Esc` `Esc` | Agent/tool running | Interrupt current operation, return to prompt             |
| `Ctrl+C`    | Any                | Graceful shutdown (forces exit after 2s if agent running) |
| `Ctrl+V`    | Idle (in prompt)   | Paste image from clipboard                                |

### CLI subcommands

```bash
mma session list              # List all sessions
mma session show <id>         # Show session details
mma session export <id>       # Export a session (--format md|json|jsonl, --out <path>, --no-redact)
mma session delete <id>       # Delete a session
```

REPL equivalents include `/export [<id|name>] [--format md|json|jsonl] [--out <path>] [--no-redact]` (default file `~/.mma/exports/<name>-<id8>.<ext>`, secrets redacted).

### Data layout

```
~/.mma/sessions/
├── ses_abc123/
│   ├── meta.json        # SessionMeta (name, model, counts, timestamps)
│   ├── history.jsonl    # JSONL of SessionMessage[] (user/assistant/tool summaries)
│   └── session.jsonl    # Detailed execution log: tool calls, args, results, timing, errors
└── ses_def456/
    ├── meta.json
    ├── history.jsonl
    └── session.jsonl
```

### Config

In `config/defaults.ts` / `~/.mma/config.json`:

```json
{
  "session": {
    "autoSave": true,
    "maxSessions": 50,
    "isolateMemory": false
  }
}
```

Messages are persisted to `history.jsonl` on each iteration. `session.jsonl` records full tool call details (arguments, raw output, duration, success/failure) for debugging and post-mortem analysis. Context compaction no longer duplicates existing messages — it writes a single compacted summary to the session. The `search_history` tool searches across all `history.jsonl` files.

**Context observability events** (in `session.jsonl`, added for post-mortem context analysis):

- `context` (kind `start`, iteration 1): initial context structure — `window`, `systemBudget`/`reserveBudget`/`historyBudget`, `systemTokens`, `toolTokens`, `contextTokens`, `quality`, `messageCount`, plus `blocks[]` — per-block system-prompt breakdown (`label`, `priority`, `tokens`, `included`) and what the budget excluded.
- `context` (kind `iteration`, every iteration): live context state before the LLM call — `contextTokens`, `quality`, `messageCount`, `compactionCount`, `iterationsSinceCompaction`. Lets you reconstruct exactly when/how the context filled up.
- `compaction` (enriched): `reason` (`interval`/`quality-triggered (N% < 40%)`/`overflow (N > M)`/`after_tool`), `tokensBefore`/`tokensAfter`, `qualityBefore`/`qualityAfter`, `messagesBefore`/`messagesAfter`, `removedTurns`/`keptTurns`, and `summary` — the actual `[Compressed: …]` block (task/files/errors/tried-and-failed). Tokens before/after come from `ContextManager.compact()` (which now returns a `CompactResult | null`, null when there is nothing to compact).
- `llm_usage` (per LLM call): `promptTokens`/`completionTokens`/`totalTokens`, `source` (`api` when the backend returned `usage`, else `estimate` — llama.cpp streaming often omits `usage`, so estimates are marked explicitly), `durationMs`.

Source: `ContextManager.getSnapshot()`/`compact()` in `src/modules/context/manager.ts`, `PromptBuilder.build()` block breakdown in `src/core/prompt-builder.ts`, logging in `src/core/session-logger.ts` (`logContext`/`logLlmUsage`/`logCompaction`).

## Project Map

MMA automatically builds and maintains a map of the current workspace.

- Triggered at agent startup; cached to `<project>/.mma/index-cache.json`.
- Re-scans on file changes via a file watcher and exposes the result as a system prompt block.
- `project_map` tool lets the model query the current map:

| Action    | Parameters | Description                                          |
| --------- | ---------- | ---------------------------------------------------- |
| `summary` | —          | Languages, file counts, top directories, key exports |
| `refresh` | —          | Force a full re-index                                |
| `find`    | `query`    | Search files by path or exported symbol name         |

- Source: `src/modules/indexer/` (`walker.ts`, `cache.ts`, `module.ts`, `map-select.ts`, `map-command.ts`).

The same actions are available to the user (not only to the model):

| CLI               | REPL    | Action                                                             |
| ----------------- | ------- | ----------------------------------------------------------------- |
| `mma map`         | `/map`  | Print the project map (the exact text injected into the prompt)   |
| `mma map refresh` | `/map refresh` | Force a full re-index, then print the map                  |
| `mma map find <q>`| `/map find <q>` | Search files by path or exported symbol name              |

### Map file selection (`map-select.ts`)

The walker indexes files in arbitrary `readdir` order, so a naive `slice(0, N)` could list only docs/config/tests and **no source files at all** (observed on this repo: the first 100 walked files contained zero `src/` entries) — the model then received a "project map" with no code in it. `selectMapFiles(files, 80)` now:

1. drops lockfile noise (`package-lock.json`, `bun.lockb`, `yarn.lock`, …);
2. ranks source before test files, tests before docs/config;
3. within a rank, puts the top-level directory with the most source files first — the densest code root is almost always the real source tree, so no directory names are hardcoded;
4. then shallower paths, then alphabetical — deterministic, so the block does not change between turns (prefix KV-cache).

The index itself still contains every file (so `project_map find` is unaffected); only the prompt listing is ranked and capped.

### Language registry & symbols (`symbols.ts`)

Indexing and symbol extraction are data-driven in `symbols.ts`:

- `EXT_TO_LANGUAGE` — extension → language id; a single place to add a language. Indexed extensions now cover TypeScript/JavaScript (`.ts/.mts/.cts/.tsx/.js/.mjs/.cjs/.jsx`), Python (`.py/.pyi`), Rust, Go, Java, Kotlin, C#, Ruby, PHP, Swift, Scala, C/C++ (`.c/.h/.cpp/.cc/.cxx/.hpp/.hxx`), Shell (`.sh/.bash/.zsh`), Lua, plus data formats (JSON, Markdown, YAML, TOML, XML, HTML/CSS).
- `RULES` — per language: a `code` flag (used for map ranking) and an `extract()` function returning public/exported symbol names. Extraction is regex-based by design (no parser dependency, cheap enough to run on every file): TS/JS handles `export const|function|class|interface|type|enum`, `export default` and `export { a, b as c }`; Python takes top-level `def`/`class`; Rust `pub fn/struct/enum/trait/const/type/mod` + macros; Go `func`/methods/`type`; Java/Kotlin/C#/Swift/Scala type+method keywords; Ruby/PHP declarations; C/C++ `class/struct/enum/union/namespace`; Shell and Lua functions.
- Symbols are deduped and capped (`MAX_SYMBOLS_PER_FILE = 40`) so a generated file cannot bloat the map.

Adding a language is one `RULES` entry plus one or more `EXT_TO_LANGUAGE` lines. `isCodeLanguage()` is consumed by `map-select.ts` (single source of truth for what counts as source).

### Ignored directories (`walker.ts`)

`IGNORE_DIRS` skips directories that never hold project source but would flood the index. It is ecosystem-wide, not Node-only: Node/JS (`node_modules`, `dist`, `build`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`), Python (`venv`, `.venv`, `env`, `virtualenv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tox`, `site-packages`), Rust (`target`), Go/PHP/Ruby (`vendor`, `.bundle`), JVM (`.gradle`, `out`), .NET (`obj`), Apple (`pods`, `deriveddata`), VCS/IDE (`.git`, `.hg`, `.svn`, `.mma`, `.idea`, `.vscode`). Matching is case-insensitive; the file watcher matches whole path **segments** (not substrings) so short names like `env`/`out`/`obj` do not black out `environment.ts` or `about/`.

## UI Rendering

Agent output flows through `src/ui/renderer.ts` (`Renderer`), chosen automatically: **rich** when `process.stdout.isTTY && !process.env.CI`, otherwise **plain**. Colors come from `src/ui/colors.ts` (`createColors`), enabled only on a TTY and disabled in CI / on `NO_COLOR` (overrides picocolors' win32 default-on).

**Event flow:** `Agent.run()` takes `(onChunk, onMeta, onTool, onPhase)`. The renderer maps:

- `text` → markdown-formatted streaming (via `FormattingStream`)
- `meta` → raw status/output lines (reasoning, tool results, MoE status)
- `onTool` `start`/`end` events → inline tool headers (rich, default) or `⚙ name` prefixes (plain)
- `onPhase` `thinking`/`done` → thinking spinner (e.g. `⠋ Thinking…`) while the model loads and generates; auto-cleared on first chunk, tool card, or `done`

**Rich mode extras:**

- Spinner (`src/ui/spinner.ts`) on stderr during LLM wait and tool execution — single-line `\r` overwrite, cleared before any text write.
- **Inline tool headers** (default, opencode-style): each tool call opens with a marker line — `← Editing path` (write/edit/create/move/delete), `→ Reading path` (read/list/file_info), `✱ Searching ...` (glob/grep), `$ Running command ...` (bash), `⚙ ...` (others). Tool output streams under a 2-space gutter (no box); `toolEnd` prints `✓ Nms` + a dim `divider()` + blank line to separate tool calls.
- **Boxed tool cards** (`ui.toolStyle: "box"`): legacy `┌─ ✓ write_file ─┐` cards with args summary, wrapped body, duration.
- Model commentary accompanying a tool call is shown by default (`ui.toolComments: true`), with a sanitizer that drops raw JSON payloads (`isToolCallJson` in `src/core/agent.ts`).
- Markdown v2: aligned tables (`│` borders), blockquotes, checkboxes, hr, italic, links.
- Diffs (`src/ui/diff.ts`) render the plain content with colored `+`/`-` markers only — no background color.

**Config:** `ui.spinner`, `ui.toolStyle` (`"inline"` default, `"box"` legacy), and `ui.toolComments` in `config/defaults.ts`. Tool `friendly` labels come from i18n `tool.friendly.*`. All user-facing strings still go through `t()` (rule #8) — this includes REPL header, `/help` groups, setup wizard, and tool cards.

## Plugins

> **Guide:** [docs/plugins.md](./docs/plugins.md) — hooks, загрузка, примеры.

Плагины перехватывают события агента. Интерфейс — `AgentPlugin` (`src/modules/types.ts`), диспетчер — `src/modules/plugins/manager.ts`. Изоляция ошибок: падение плагина не останавливает агента и других плагинов.

**Загрузка:** встроенные (`src/modules/plugins/builtin/`), глобальные `~/.mma/plugins/`, проектные `<project>/.mma/plugins/` (`.ts` — только под Bun). Два варианта размещения: **отдельный файл** `*.{ts,js}` в корне каталога плагинов, либо **папка-плагин** с entry-файлом (`plugin.ts/js` → `index.ts/js`; остальные файлы папки подключаются entry-файлом через относительные импорты — см. `src/modules/plugins/loader.ts`). Экспорт `default` или `plugin`. Папки без entry пропускаются.

**Хуки:**

| Хук                               | Момент                            | Особенность                                                   |
| --------------------------------- | --------------------------------- | ------------------------------------------------------------- |
| `onBuildPrompt`                   | сборка системного промпта (1 раз) | строка добавляется блоком `low`-приоритета                    |
| `onBeforeThink`                   | перед каждым LLM-вызовом          |                                                               |
| `onAfterThink(ctx, response)`     | после ответа LLM                  | `response` = `LLMResponse` или `null`                         |
| `onBeforeTool`                    | перед тулом                       | `false` = заблокировать (короткозамыкает)                     |
| `onAfterTool`                     | после тула                        | может мутировать `result.output`                              |
| `onToolCall`                      | LLM вернул тул-вызов              | `ctx.toolName`, `ctx.args`                                    |
| `onToolStart` / `onToolEnd`       | тул-карточка открыта/закрыта      | `onToolEnd` даёт `result` + `durationMs`                      |
| `onPhase`                         | спиннер: `thinking` / `done`      |                                                               |
| `onText` / `onMeta`               | чанк стриминга                    | вернуть строку — заменить на экране, `undefined` — пропустить |
| `onError`                         | ошибка LLM                        |                                                               |
| `onSessionStart` / `onSessionEnd` | жизненный цикл сессии             |                                                               |
| `onTurnEnd`                       | завершение `Agent.run()`          | один вызов на ход (ответ/ошибка/interrupt) + `TurnSummary`; сигнал «весь ход завершён» |
| `ctx.hostBridge`                  | любой хук                         | `HostBridge {isBusy, submit(text,{images}), interrupt}` — управление агентом из плагина через тот же путь, что терминальный ввод (регистрирует REPL); отсутствует в single-run |

**UI-хуки** (`onPhase`, `onToolStart`/`onToolEnd`, `onText`/`onMeta`) дают плагинам видимость и контроль над тем, что видит пользователь: спиннер, тул-карточки, стриминг. `onText`/`onMeta` влияют только на отображение, `result.text` не меняется.

### Versioning & dedup

- `AgentPlugin` supports optional `version` (semver) and `minMmaVersion` (minimum MMA version, semver).
- **Dedup by name** in `PluginManager.register(plugin, source?)`: the higher `version` wins (unversioned = "0.0.0"); the loser is dropped and the caller is notified via the `RegisterResult` (`registered` / `skipped_older` / `duplicate`). Applies across global + project dirs.
- **Compatibility gate** in `PluginLoader`: when `minMmaVersion` > current MMA version the plugin is skipped with a `plugin.incompatible` warning (reuses the existing `plugin.skipped` machinery). Bootstrap passes `mmaVersion` (from `readMmaVersion()` in `src/core/version.ts`) and `source` (`global` / `project`).
- **Source tracking**: `PluginInfo { plugin, source }` via `PluginManager.getPluginInfos()`. `getAllPlugins()` stays backward-compatible.
- **CLI:** `mma plugins list` (external plugins only; `--all` includes builtins) and `mma plugins list --all`; REPL `/plugins` shows version + `[source]` per non-builtin plugin.
- `lint-on-write` and `notify` are marked `isBuiltin = true`.

### Example plugin: `trace-server` (live browser trace)

> **Source:** `examples/plugins/trace-server/` — zero-dependency example of every UI hook, split into a **folder plugin**: `plugin.ts` (entry) + `state.ts` (process-global shared state + SSE primitives) + `util.ts` (clip/scrub/summarize) + `context.ts` (snapshots + history text) + `plans.ts` (on-disk plan reading + poll) + `server.ts` (HTTP/SSE, serves the three frontend assets verbatim) + `page.html` + `styles.css` + `app.js` (frontend). All assets are read from disk at load time and served as-is — never template-processed (inlining the page into a template literal broke `'\n'` in the JS and killed the page).

Starts a local HTTP server on `onSessionStart` and streams the whole agent loop to the browser over **SSE** (`node:http`, works under Bun and the Node dist — no `Bun.serve`/WebSocket dependency): phases, LLM calls, `tool_start`/`tool_end` with **full** args and results (paired client-side by `toolCallId`), errors, streamed text/meta (coalesced server-side, 350ms debounce), and **context tracking** — a live context bar (tokens/budget, quality %, compaction count, iterations since compaction, message count) fed by `context` events, plus `compaction` events rendered as CTX log entries (tokens before/after, quality before/after), a **side panel** with the full conversation history as text (`context_text` events, throttled + deduped) and the agent's **plans** (current, all, activity feed) read from `<project>/.mma/plans/` on disk. Live only — no session files are read. The frontend is split into three self-contained files (dark terminal, per-type color filters, search, pause/clear/auto-scroll, thinking indicator, elapsed timer, auto-reconnect): `page.html` (markup), `styles.css` (theme), `app.js` (SSE + rendering) — served from `/`, `/styles.css`, `/app.js` respectively.

The context events need the `contextManager` in the plugin hook contexts — `agent.ts` passes it to `runOnPhase`, `runOnSessionStart`, `runOnBeforeThink`, `runOnAfterThink`, `runOnToolStart`, `runOnToolEnd`, `runOnError`, `runOnText`, `runOnMeta`, `runOnSessionEnd`. Dedup: both the global and project copies of the plugin load in one process, so a shared server lives on `Symbol.for("mma.trace-server")` (`globalThis`), `startServer()` dedupes concurrent starts with an in-flight promise (`state.starting`), and identical context snapshots are broadcast once.

- Install: copy the whole `trace-server` folder to `~/.mma/plugins/` or `<project>/.mma/plugins/`; the URL is printed at session start ("live trace → …") and auto-opened.
- Config via env: `MMA_TRACE_PORT` (default random), `MMA_TRACE_HOST` (default `127.0.0.1`), `MMA_TRACE_MAX_CLIENTS` (5), `MMA_TRACE_OPEN=0` (no browser auto-open).
- Security: binds localhost only; payloads pass through a light scrub that masks credential-shaped values (`sk-…`, `Bearer …`, `api_key`/`token`/`password`/`secret` fields). Local-only, no auth.
- Smoke test: `_testing/trace-server-smoke.ts`; e2e harness in `_testing/trace-live/` (real agent run with the plugin in the sandbox's `.mma/plugins/`, watcher over SSE).

### Example plugin: `web-ui` (bidirectional chat in the browser)

> **Source:** `examples/plugins/web-ui/` — folder plugin, sibling of trace-server: `plugin.ts` (entry) + `state.ts` (global state + SSE broadcast) + `util.ts` (clip/scrub/validation) + `history.ts` (history.jsonl tail backfill) + `plans-snap.ts` (on-disk plan snapshot + 2s change poll) + `server.ts` (HTTP/SSE/REST) + assets `page.html` / `styles.css` / `app.js`.

Unlike trace-server (read-only), web-ui is **bidirectional**: the browser sends messages through `POST /api/message {text, images?}` → `ctx.hostBridge.submit()` → the same `Repl.runAgent` path as terminal input; `POST /api/interrupt` aborts the current turn. The page streams the whole loop over SSE (`/events`: session/state/phase/llm_start/llm_end/tool_start/tool_end/text/meta/error/plans/context/turn_end), renders collapsible tool cards and the plan checklist, backfills the last ~30 messages from `history.jsonl` on load (`GET /api/state`), supports image attach (drag-n-drop → client-side canvas downscale to 800px/JPEG60 → data URL → bridge → `addPendingImage`), and shows a busy-gated input with a Stop button.

- Agent reworks this plugin rides on: **`HostBridge`** (`{isBusy, submit(text,{images}), interrupt}` — registered by the REPL via `pluginManager.setHostBridge()`, merged into every hook ctx as `ctx.hostBridge`) and the **`onTurnEnd(ctx, TurnSummary)`** plugin hook (dispatched once per completed `Agent.run()`, single + MoE paths — the only reliable "turn finished" signal).
- Install/config: copy the folder to `~/.mma/plugins/`; env `MMA_WEBUI_PORT/HOST/TOKEN/MAX_CLIENTS/MIN_INTERVAL_MS/OPEN/CONFIG_DIR`. Token auth on `/api/*` is mandatory for non-loopback binds; POST bodies are size-capped (32KB text, ≤3 images × ~6MB data URLs), rate-limited, Origin-checked; payloads scrubbed like trace-server.
- Smoke test: `_testing/web-ui-smoke.ts` (stub bridge + fixtures for plan/history, asserts the full POST→submit→turn_end loop). Unit tests: `tests/web-ui-server.test.ts` (9 — routing, caps, busy, auth, rate limit), `tests/modules/plugin-host-bridge.test.ts` (7), `tests/core/agent-turn-end.test.ts` (3), `tests/cli/repl-bridge.test.ts` (4).

## Web mode (`mma web`)

> **Source:** `src/modules/webui/` (`state.ts`, `server.ts`, `forward.ts`, `module.ts`, `assets.ts`, `util.ts`) + `src/cli/web-command.ts`, `src/core/web-host.ts`. Design: [docs/specs/2026-09-23-mma-web/design.md](../specs/2026-09-23-mma-web/design.md).

`mma web [--port N] [--host H] [--token T] [--no-open]` runs the agent **without a TTY**, as a full alternative to the terminal REPL: same `bootstrap()`, same `Agent`, same config and sessions, a second renderer (browser) instead of `LineEditor`. The terminal REPL stays fully supported and unchanged; terminal and web are separate processes (separate sessions if run at once).

- **Config via env** (CLI flags map onto them): `MMA_WEBUI_PORT` (default random), `MMA_WEBUI_HOST` (default `127.0.0.1`), `MMA_WEBUI_TOKEN`, `MMA_WEBUI_OPEN=0` (no browser auto-open), `MMA_WEBUI_MAX_CLIENTS` (SSE client cap).
- **Transport:** SSE `GET /events` — `state`, `text`, `meta`, `phase`, `tool_start`, `tool_end`, `turn_end`, `error`. Plan/usage/session are **not** streamed; the client polls `GET /api/state` (full snapshot for reconnect resync) every 2s. `question`/`output` are future phases (not emitted yet). REST: `POST /api/message` (`{text, images?}` → `Host.submit`, 409 busy), `POST /api/interrupt`, `POST /api/command` (`{line}` → slash-command map), static `GET /`, `/app.js`, `/styles.css`.
- **Auth & caps:** binds loopback by default; a non-loopback bind **requires** a token (`--token` or `MMA_WEBUI_TOKEN`), checked on `/events` and `/api/*`; writes pass a same-origin check; body size and SSE client caps apply.
- **Relation to the `examples/plugins/web-ui` plugin** (above): that plugin remains an **example**; `mma web` is the first-class, core mode — same proven transport/auth design, but wired to the shared `Host` seam (`src/core/host.ts`) and `WebUiModule` instead of a plugin hook bridge.
- **Phase 3 note:** slash-command dispatch from the browser (`POST /api/command`) is a documented **no-op** for now — the endpoint exists and is authed, but `WebHost.executeCommand` does nothing until the shared handler map is wired.

## Context Budget (dynamic, from model.contextWindow)

| contextWindow | System (10%) | Reserve (15%) | History (75%) |
| ------------- | ------------ | ------------- | ------------- |
| 32K           | 3K           | 5K            | 24K           |
| 64K           | 6K           | 10K           | 48K           |
| 128K          | 13K          | 19K           | 96K           |

Compaction triggers at 75% history budget or every 15 iterations. Keeps last 6 turns full; older turns → structured summary preserving created/updated files, plan state, key decisions, and errors. The summary is saved once to the session log — no duplication of old messages. Token counting uses `js-tiktoken` via injected `TokenCounter` when available, falling back to `content.length / 2` heuristic for backwards compatibility.

### Instructions overflow (AGENTS.md / project map exceeding the system budget)

> **Source:** `src/core/prompt-overflow.ts`, integration in `Agent.resolvePromptOverflowOnce` (`src/core/agent.ts`), startup dry-run in `bootstrap.ts`.

Prompt blocks carrying a semantic `kind` (`PromptBlockKind`: `"instructions"` for AGENTS.md, `"project-map"` for the indexer map) are overflow-aware. When such a block does not fit the system-prompt budget:

1. **Startup dry-run** (bootstrap, banner): `dryRunOverflow` reproduces the first build with the same block set and warns the user with a concrete fix. `overflowHint()` states the raw requirement and **both levers** — raise `contextWindow` (`mma context <N>`, or edit `provider.entries[].contextWindow` in `config/provider.json` when the entry overrides it) **or** keep the window and raise the system-prompt share (`mma context --system <f>`). Exact minimums: `requiredContextWindow(N, f) = ceil(N/f)` and `requiredSystemFraction(N, W) = ceil(N/W×100)/100`.
2. **Budget controls**: `mma context [<size> | --system <f> | --reserve <f>]` (CLI) / `/context [<size> | system <f> | reserve <f>]` (REPL) set the window or a share; no argument prints the system/reserve/history breakdown in tokens and %. Shares are validated 0.05–0.9 with system + reserve < 0.95 (`src/config/budget.ts`).
3. **Resolution** (Agent, once before the first LLM call): `resolvePromptOverflow` compresses the block into the remaining budget:
   - LLM summarization via the active provider (prompt preserves paths/commands/rules), cached in `<project>/.mma/cache/prompt-summaries/<sha256(kind|budget|content)>.md` — cache is invalidated by file edits or budget changes;
   - fallback on failure / `instructions.summarize: false`: hard truncation with a `[...truncated...]` marker.
4. **Model hint**: a small `essential` block tells the model which blocks were compressed (and which did not fit at all) and points to `read_file AGENTS.md` for the full text.
5. **User notifications**: the startup dry-run only says the block "will be summarized before the first run"; without a notice the first prompt looks hung while a local model rewrites a large AGENTS.md. `resolvePromptOverflow` now logs (en+ru, `prompt.overflow.*`): a "compressing N block(s)…" line before it starts, a per-block "summarizing \"label\" (N → M tok)…" line right before the model call, a "truncating …" line on the fallback, and a failure line when summarization throws before falling back to truncation.

Related startup notices localized under `env.*`: model auto-load success/failure, reasoning probe result, project indexing start/finish/failure, unreadable index entries, and background-processes-killed-on-shutdown.

Config: `instructions.summarize` (default `true`) — `~/.mma/config/core.json`.

### Context probe (actually loaded model context)

> **Source:** `getLoadedContextLength` (`src/llm/model-loader.ts`), background promise in `bootstrap.ts`, banner + `context_probe` session entry in `repl.ts`.

At startup MMA asks LM Studio's native API (`/api/v1/models`) for the context length the model is ACTUALLY loaded with (`loaded_instances[].config.context_length`, fallback `max_context_length`) and compares it with the configured `contextWindow`:

- loaded < configured → warning (overflow/429 risk; per design NO auto-clamp — the user decides);
- loaded > configured → info suggesting `mma context <actual>`;
- probe result is logged to `session.jsonl` as a `context_probe` entry (visible in `session show`).

Non-LM-Studio providers degrade silently (probe returns null).

## Cost Tracking (pricing / budget display)

> **Source:** `src/modules/pricing/` (`prices.ts` — builtin price table + cost math; `index.ts` — `CostTracker`).

When a model has a known price, MMA shows the session's running cost **together with token usage**:

- **Inline tool footer** — each `toolEnd` appends `cost $X` next to `ctx ±N` (rich + plain modes).
- **After calls** — REPL context bar (`repl.cost`) and the single-run result (`run-result.ts` / `--json` `totalCost`).
- `AgentResult.totalCost` is set when pricing is enabled and the model's price is known; `ToolEvent.costUsd` carries the running total at each tool end.

**How prices resolve** (`resolvePrice`): user `pricing.overrides` win → builtin table (`ZEN_PRICES`) → unknown = no cost shown. Model ids are normalized by stripping provider prefixes (`opencode/`, `opencode-go/`, `openai/`, `anthropic/`) and vendor paths, so one table serves Zen and Go.

**Config** (`~/.mma/config.json`):
```json
{ "pricing": { "enabled": true, "overrides": { "opencode/gpt-5.5": { "input": 1, "output": 2 } } } }
```

**Hosted providers** with fixed base URLs are selectable via `mma provider use opencode-zen|opencode-go` and the setup wizard (`HOSTED_BASE_URLS` in `src/cli/setup.ts`): Zen → `https://opencode.ai/zen/v1`, Go → `https://opencode.ai/zen/go/v1`. Both are OpenAI-compatible (`/chat/completions`); model ids use the `opencode/…` / `opencode-go/…` prefix. Builtin pricing is maintained from https://opencode.ai/docs/zen/ and /docs/go/ — update `ZEN_PRICES` when those tables change.

**Provider budget** — `mma usage` (`src/llm/provider-budget.ts`) queries the active provider's balance. **OpenRouter only**: `GET /key` for per-key `usage`/`limit`/`limit_remaining` and, with a management key, `GET /credits` for the account balance (`total_credits - total_usage`). Other providers return `unsupported` (OpenCode Zen/Go do not expose balance via API key). The fetch is explicit (no startup probing), never throws, and logs suppressed `/credits` failures.

## Prompt Caching & Cache Metrics

> **Source:** `src/llm/cache-usage.ts`, `src/core/agent/prefix-monitor.ts`, `src/cli/cache-line.ts`, `src/modules/providers/cache.ts`. Design: [docs/specs/2026-09-17-prompt-caching-budget.md](../specs/2026-09-17-prompt-caching-budget.md).

Agent loops resend the whole context every iteration; providers reuse the KV cache of the matching prompt prefix. MMA makes that reuse **measurable and cheaper** across cloud and local backends without vendor lock-in.

**Capability descriptor** — each provider declares its cache behavior (`ProviderCapabilities.cache`, defaults in `presets.ts`, overridable per entry via `ProviderEntry.cache`):

| Field | Purpose |
| ----- | ------- |
| `mechanism` | `auto` / `explicit` / `local` / `none` |
| `report` | response format: `openai` / `deepseek` / `anthropic` / `ollama` / `none` |
| `sessionHeader` | send `x-opencode-session` (Zen/Go sticky routing) |
| `requestCachePrompt` | send `cache_prompt: true` (llama.cpp) — off by default (nondeterminism) |
| `requestPromptCacheKey` | send `prompt_cache_key` (OpenAI) |
| `requestSessionId` | send `session_id` (OpenRouter sticky routing) |
| `requestCacheControl` | mark blocks with `cache_control` (Anthropic; inert until a real provider lands) |

**Usage parsing** (`parseCacheUsage`) normalizes all known shapes into `Chunk.usage.cache` (`CacheUsage`): OpenAI `prompt_tokens_details.cached_tokens` (+`cache_write_tokens`) also covers LM Studio/llama.cpp/vLLM/OpenRouter/Zen/Go/Gemini; DeepSeek uses `prompt_cache_hit_tokens`/`_miss_tokens`; Anthropic uses `cache_read_input_tokens`/`cache_creation_input_tokens`; Ollama derives cached tokens from `prompt_eval_count` vs a client estimate. Missing fields mean "unknown", never a fake cache miss.

**Prefix monitor** (`diffPrompt`) is client-side and provider-agnostic: it compares consecutive prompts and classifies why the prefix broke (`system` / `tools` / `history` / `volatile`), logged as `cacheStable` + `cacheCause` in `llm_usage`. It works even when the provider reports nothing.

**LM Studio caveat:** its OpenAI-compatible `/v1/chat/completions` returns no `prompt_tokens_details` (and `stats` is empty), so `cached_tokens` is unavailable there — only the prefix monitor reports. `/v1/responses` does expose `input_tokens_details.cached_tokens` (with a known accounting bug), and the native `/api/v1/chat` exposes TTFT; neither is used by the OpenAI-compatible path. To let any OpenAI-shaped backend report usage (and cache fields where supported) in streaming, requests send `stream_options: { include_usage: true }` (`requestStreamUsage`). For local single-agent runs, prefer loading the model with `parallel: 1` — LM Studio's parallel slots contend for the KV cache and can defeat reuse.

**Cost** — `ModelPrice.cachedInput`/`cacheWrite`; cached reads are billed at the cached rate and savings tracked (`CostTracker.saved`). Only API-sourced cache usage affects pricing. Zen/Go cached-read prices live in `ZEN_PRICES`.

**Display** — `formatCacheLine` renders one footer line: `Cache: 87% hit · saved $0.42` (cloud), `Cache: 91% hit` (local, no price) or `Prefix stable: 93% · broke: tool set` (no telemetry). Shown in the REPL context bar, single-run result and `--json` (`cache`); `mma session show <id>` aggregates `llm_usage` into tokens + cache hit rate.

**Tuning cache hits:** keep volatile content out of the prefix (timestamps, changing tool sets). Note that mid-session tool-set narrowing invalidates the whole cached prefix — the monitor surfaces this as `broke: tool set`.

## Auto-Update

Self-update is a fire-and-forget background check — it never blocks startup.

- **Check:** `Updater.check()` fetches `https://registry.npmjs.org/micro-models-agent` (5s timeout); the current version comes from `package.json` (`readVersion()` in `main.ts`).
- **Install:** when a newer version exists and `autoInstall: true`, runs `npm install -g micro-models-agent@<latest>` in the background (`Updater.install()`, injectable runner for tests). The running process keeps working on the old version; the update applies on next launch.
- **Config** (`updater` in `~/.mma/config.json`):
  - `enabled` (default `true`) — master switch
  - `checkOnStart` (default `true`) — check at startup
  - `autoInstall` (default `true`) — auto-run `npm install -g`; `false` → only notify
  - `intervalMs` (default `0`) — `0` = single check per launch; `>0` = permanent background re-check loop
- **Source:** `src/modules/updater/` (`checker.ts`, `module.ts`). Fired from `main.ts` via `startAutoUpdate()`; all errors are swallowed (best-effort). Notifications go through i18n keys `updater.*`.
