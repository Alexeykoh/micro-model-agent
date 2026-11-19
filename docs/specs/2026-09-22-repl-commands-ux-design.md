# REPL Slash-Commands UX Redesign — Design Spec

- **Date:** 2026-09-22
- **Status:** Implemented (2.0.0)
- **Scope:** REPL slash-commands (`src/cli/repl-commands.ts`), registry/help (`src/cli/repl.ts`), completion (`src/cli/completer.ts`), i18n, new session export (REPL + CLI).
- **Versioning:** **MAJOR** — `/reasoning`/`/verbose` bare no longer toggle; several commands now persist; alias `use` removed from `/resume`.

## 1. Context

Audit of all REPL commands found: `/status` duplicates `/config`; `/reasoning` and `/verbose` hide a toggle behind a bare argument, contradicting their `usage`; persistence is inconsistent (some commands save, some don't; REPL diverges from CLI); completion is missing for most subcommands/arguments; unknown-subcommand errors differ; `/sysprompt` dumps everything; `/lsp` bypasses the handler-map rule; no session export.

## 2. Goals

1. Predictable behavior: **no hidden toggles** — a bare argument shows, never mutates.
2. One honest settings surface (`/config`), with profile commands as pure sugar.
3. Uniform, reversible persistence.
4. Completion for subcommands, flags, config keys and enum values.
5. Session export (REPL + CLI).
6. Unified errors/help, less chat noise.

## 3. Non-goals

- No changes to LLM, security, providers, session storage format.
- `/config` handles **scalars only**; arrays/objects (`experts`, `mcpServers`, …) are not editable via REPL.
- No TUI config editor.

## 4. Decisions (locked)

| # | Decision |
|---|----------|
| D1 | `/config` keys are **literal `config.json` paths**; short forms are aliases. |
| D2 | Any setting change **saves `config.json` immediately** and prints `saved · /config reset <key>`. |
| D3 | **`/config reset <key>`** restores the value captured at **session start** (boot snapshot); `/config reset --all` restores every key changed during the session. If a key is already at its boot value, report "already at session value". |
| D4 | Profile commands are **pure sugar** over a single `setConfigValue(key, value)` — no own logic. |
| D5 | **`/status` is a compact one-line summary** (`model · provider · session · ctx`); `/config` is the full table. They share display helpers; neither duplicates write logic. |
| D6 | `/reasoning` bare = **status**; display via `show|hide` (aliases `on|off`); effort via `level <...>`. |
| D7 | `/verbose` bare = **status**; levels change only explicitly. |
| D8 | Hard change, no deprecation shims. |
| D9 | `/config` full dump = **STYLE.md table**; shows canonical key, value, domain, hint. |
| D10 | `/clear` clears the **screen only**; `/new` clears context. |
| D11 | Reasoning status line: `Reasoning: display on · effort auto (auto policy)` / `… effort high (auto policy off)`. |
| D12 | Shares accept `0.1` **and** `10%`. |
| D13 | Persistence is universal; `--verbose` CLI flag is session-only, and status reports **effective value + source**. An explicit `/verbose <level>` (or `/config ui.verbosity …`) **clears the session flag**, so the command always takes effect. |
| D14 | `reconfigure` runs only for keys that affect agent construction (see §5.2). |
| D15 | `/export` default writes to `~/.mma/exports/`, prints path, and reports redaction. An empty session is **not** exported (warn instead). |
| D16 | `showReasoning` **overrides** `ui.verbosity=quiet` for reasoning lines: an explicit display request beats ambient quiet. |
| D17 | Changing `locale` **re-registers commands and the completer** so `/help` and usage strings switch language immediately. |
| D18 | Unknown commands that were former aliases (e.g. `/use`) get a "did you mean …" hint. |

## 5. `/config`

```
/config                          full table (all managed keys)
/config <key>                    show one value
/config <key> <value>            set, save, (maybe) reconfigure
/config <group>                  show all keys in a group (e.g. /config contextBudget)
/config reset <key>              restore the session-start value for one key
/config reset --all [--yes]       restore session-start values for all keys changed this session
/config migrate                  legacy migration (unchanged)
```

### 5.1 Session snapshot
On REPL start the managed keys are deep-copied into an in-memory **boot snapshot**. `reset` restores from it — intuitively "undo my changes this session", not "jump to a schema default" (which for `provider.active` is `undefined`/legacy and would be ambiguous). Keys never changed show `already at session value`. The snapshot is in-memory only and never written to disk.

`reset --all` asks for one-line confirmation **only in a TTY**; in non-interactive input (pipe, `--json`, scripts) it requires an explicit `--yes`, otherwise it aborts with a hint (never blocks on `question()`).

### 5.2 Key registry (canonical = literal config.json path)

| Canonical key | Aliases | Type / allowed | reconfigure |
|---|---|---|:---:|
| `model` | — | string (soft-validated vs model cache) | ✔ |
| `provider.active` | — | string (must match an entry) | ✔ |
| `contextWindow` | `context.window` | int ≥ 1024 | ✔ |
| `contextBudget.systemPrompt` | `context.system` | 0.05–0.9, `system+reserve ≤ 0.95` | ✔ |
| `contextBudget.responseReserve` | `context.reserve` | 0.05–0.9, `system+reserve ≤ 0.95` | ✔ |
| `showReasoning` | `reasoning.show` | `on/off` (also true/false) | — |
| `reasoning.mode` | `reasoning.level` | `auto\|default\|none\|low\|medium\|high\|max` | ✔ |
| `ui.verbosity` | `verbosity` | `quiet\|normal\|verbose` | — |
| `maxToolIterations` | — | int ≥ 1 | — |
| `stuckThreshold` | — | int ≥ 1 | — |
| `logLevel` | — | `silent\|error\|warn\|info\|debug` | — |
| `locale` | — | `en\|ru` | — |

Read-only (informational) key: `version`. The active session is printed as a separate dim line under the table (it is dynamic runtime state, not a config field).

The `/config` dump prints **canonical keys only**. Aliases are accepted for input and appear in completion marked `(alias)` — they never create a second entry in the dump, so there is one visible source of truth.

### 5.3 Validation rules
- Unknown key → error listing valid keys (nearest-match suggestion when possible).
- Invalid value → error with range/set; shares accept percent (`10%`).
- Combined constraint `system + reserve ≤ 0.95` enforced on **both** keys.
- Read-only → "read-only".
- Model value not in a populated model cache → **warning, not block** (offline-safe).

### 5.4 Mutation contract (single source of truth)
`setConfigValue(config, key, rawValue)`:
1. resolve canonical key (alias map),
2. validate type/range,
3. write field,
4. `saveConfig`,
5. if registry says `reconfigure` → `agent.reconfigure(config)`,
6. return a result the caller renders as `saved · /config reset <key>`.

Sugar commands call exactly this. No duplicated validation or save logic.

## 6. Command surface after redesign

### 6.1 `/reasoning`
```
/reasoning                     status (D11)
/reasoning show | hide         display (aliases: on | off)
/reasoning level <level>       auto|default|none|low|medium|high|max
```
`/reasoning level high` == `/config reasoning.mode high`; prints `auto policy off; /config reset reasoning.mode to restore`.

### 6.2 `/verbose`
```
/verbose                       status: effective level + source (D13)
/verbose quiet|normal|verbose  set level (persists)
```
Status example: `Verbosity: normal (session flag) · config: quiet`. Setting a level with `/verbose <level>` (or `/config ui.verbosity …`) **clears the session flag**, so the command always takes effect (D13).

### 6.3 `/context`
```
/context                       breakdown + usage
/context <size>                ≥ 1024
/context system <share>        0.05–0.9 (accepts 10%)
/context reserve <share>       0.05–0.9
```
Unknown first token → clear "unknown argument" error (not `invalid_context_size`).

### 6.4 `/provider`
```
/provider list                 entries (* active, prio shown)
/provider use <name>           switch (saves); message includes reset hint
/provider add <name> [flags]   add entry (saves)
    --url <url>            base URL (fallback: HOSTED_BASE_URLS[name])
    --key <key>            API key
    --priority <n>         fallback order; lower = first
    --context-window <n>   per-entry window (tokens)
    --rpm <n>              requests/min (default 60)
    --parallel <n>         parallel tasks (default 1)
```
Usage documents each flag on its own line; completion for subcommands, flags, provider labels.

### 6.5 `/model`
```
/model list              models + certification marks
/model use <name>        set model (saves; soft-validated)
```

### 6.6 `/export` (new) and `mma session export` (new CLI)
```
/export [<id|name>] [--format md|json|jsonl] [--out <path>] [--no-redact]
mma session export <id> [--format md|json|jsonl] [--out <path>] [--no-redact]
```
- No `<id>` → active session; matching as `/resume` (exact id / prefix / name substring).
- `md` (default) readable transcript; `json` `{meta,messages}`; `jsonl` raw log.
- Default path `~/.mma/exports/<sanitized-name>-<id8>.<ext>`; `--out <path>` explicit; `--out -` stdout.
- Secrets redacted by default (`redactContextSecrets`), message: `secrets redacted (--no-redact to disable)`.
- Rotated `.jsonl.gz` supported.
- An empty session (no messages) is **not** written: warn `session has no messages`.
- Completion: session names + `--format` values.

### 6.7 Other commands
- `/help [command]` — per-command usage + examples; completion for command names.
- `/sysprompt [--full]` — default: token count + block list; full text only with `--full`.
- `/lsp status|restart|check <path>` — refactor `switch` → handler map (rule #17); completion added.
- `/map [summary|refresh|find <q>]` — completion added.
- `/skill list|loaded|load <name>|unload <name>|search <q>` — unified error format.
- `/clear` — screen only; hint points to `/new`.
- `/status` — compact one-line summary (D5), separate from the `/config` table.
- Changing `locale` re-registers commands + completer so `/help` and usage switch language immediately (D17).
- Unknown commands that were former aliases (e.g. `/use`) print a "did you mean `/resume`?" hint (D18).
- Alias review: keep `exit/quit/q`, `sessions/ls`, `delete/rm`, `new/create`; **remove `use` from `/resume`** (ambiguous).

## 7. Persistence & reversal

| Command | Effect |
|---|---|
| `/config <key> <value>` | save (+reconfigure per §5.2) |
| `/config reset <key>` / `--all` | restore session-start value(s), save (+reconfigure per §5.2) |
| `/context`, `/verbose`, `/reasoning`, `/model use`, `/provider use/add`, `/wizard` | save via `setConfigValue` / existing save |
| `/new`, `/resume`, `/rename`, `/delete` | session files (unchanged) |
| `/clear`, read-only views | none |

Every mutation prints `saved · /config reset <key>` so persistence is never a surprise.

## 8. Completion

1. `SubcommandProvider` registrations gain **descriptions** (skill, provider, model, map, context, lsp, reasoning, verbose).
2. `ConfigKeyProvider`: token 1 under `/config` → first segment; partial with `.` → next segment from the key tree (canonical + aliases).
3. `ConfigValueProvider`: value position for enum keys → allowed values.
4. `FlagProvider` for `/provider add` (`--url/--key/--priority/--context-window/--rpm/--parallel`) with descriptions.
5. `SessionNameProvider` registered for `/delete`, `/export`.
6. `SlashCommandProvider`/command-name completion for `/help`.

Best-effort: unknown segment → no items.

## 9. Errors & help conventions

- One helper renders the unified unknown-subcommand error (red, i18n) + usage.
- Unknown config key suggests the nearest valid key.
- `/help <command>` shows description, usage, and 1–2 examples.
- All new strings in `src/i18n/en.json` and `src/i18n/ru.json`.
- `/config` dump uses `renderTable` (STYLE.md), no manual padding.

## 10. Breaking changes (MAJOR)

1. `/reasoning` bare no longer toggles display (now status).
2. `/verbose` bare no longer toggles (now status).
3. `/provider use`, `/model use`, `/verbose`, `/reasoning` now persist.
4. `/context <non-number>` yields a clearer error.
5. `/sysprompt` default output shortened; `--full` for the entire prompt.
6. Alias `use` removed from `/resume` (with a "did you mean" hint).
7. `/status` is retained as a compact summary (not removed), so muscle memory keeps working.

## 11. Affected files

`src/cli/repl-commands.ts`, `src/cli/repl.ts`, `src/cli/completer.ts`, `src/cli/commands.ts`, `src/config/registry.ts`, `src/modules/session/export.ts`, `src/modules/session/manager.ts`, `src/modules/session/store.ts`, `src/config/budget.ts`, `src/core/agent/context-log.ts`, `src/i18n/{en,ru}.json`, `CHANGELOG.md`, `AGENTS.md`, `docs/agents/*`, `docs/design/ui/STYLE.md`.

## 12. Testing

- `/config` registry: get/set/reset, aliases, read-only rejection, combined-share guard, percent parsing.
- `/config reset`: restores session-start value; `/config reset --all` only touches changed keys; "already at session value"; non-TTY requires `--yes` and never blocks.
- `/reasoning` & `/verbose`: bare = status (no mutation); explicit args mutate + persist; effective-value source; `/verbose <level>` clears the session flag.
- `showReasoning=on` renders reasoning even at `ui.verbosity=quiet` (D16).
- Changing `locale` retranslates `/help` without restart (D17).
- Completion: `/config contextBudget.` → `systemPrompt|responseReserve`; `/config reasoning.mode ` → enum; `/provider add --` → flags; `/help ` → commands.
- Export: md/json/jsonl, default path, `--out -`, redaction on/off, rotated session, empty-session warning.
- Error format for every command with subcommands; former aliases produce a "did you mean" hint.
- `/status` compact summary renders and does not duplicate write logic.
- `tests/output/no-direct-console.test.ts` stays green.

## 13. Open questions

None — the two prior questions were resolved at implementation: `/config reset --all` confirms in a TTY and requires `--yes` otherwise; `/status` remains listed in `/help` as a compact summary.
