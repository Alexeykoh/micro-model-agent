# Onboarding Commands — `meet` («Познакомимся») & `init` — Design Spec

- **Date:** 2026-09-23
- **Status:** Proposed
- **Scope:** new onboarding module (`src/modules/onboarding/`), REPL commands (`/setup`, `/meet`, `/init`, `/memory`), CLI commands (`mma setup`, `mma meet`, `mma init`), provider preflight, i18n, `AGENTS.md` generation, memory edits.
- **Versioning:** **MAJOR (3.0.0)** — `mma init` changes meaning (wizard → `AGENTS.md`), wizard renamed to `mma setup`.
- **Related:** [STYLE.md](../design/ui/STYLE.md), [memory module design](./2026-08-04-memory-module-design.md), [repl-commands UX](./2026-09-22-repl-commands-ux-design.md), [testing](../agents/testing.md).

## 1. Context

- `mma init` today (`src/cli/commands.ts:43`) runs the **provider setup wizard** (`runSetup`), not an `AGENTS.md` generator. This collides with opencode's `/init` semantics.
- MMA **reads** `AGENTS.md` from `<baseDir>/AGENTS.md`, `<baseDir>/.mma/AGENTS.md`, `~/.mma/AGENTS.md` (`src/cli/repl.ts:1159`), but has **no command to create or update it**.
- The **memory module** already exists (`src/modules/memory/`): global `~/.mma/memory/{conventions,decisions,errors,facts}.md` + `preferences.json`, injected into the system prompt as "User preferences". There is no command surface to inspect or edit it.
- opencode `/init`: scans important repo files, asks targeted questions, creates **or improves in place** `AGENTS.md`; project + global scope.
- "Познакомимся" is a first-run onboarding interview: it introduces the user to the agent and records answers into memory for future sessions.

## 2. Goals

1. `init` generates/updates project `AGENTS.md` (opencode parity, LLM-driven, idempotent).
2. `meet` interviews the user and persists answers into **global** memory.
3. `[Y/n]` offer of `meet` right after first-run setup, plus on-demand `/meet` / `mma meet`.
4. A `/memory` surface to view and edit persisted memory.
5. Graceful, non-hanging failure when the provider is unreachable or the model is not loaded.
6. Full `en`+`ru` parity, output styled per STYLE.md, reversible writes.

## 3. Non-goals

- No change to `session.jsonl` schema, `--json` contract, or LLM provider contract.
- No project-scoped memory store (memory stays global; project knowledge goes to `AGENTS.md`).
- No TUI / alternate renderer; `box()` remains wizard-only.
- No auto-run of `meet`/`init` without user intent.
- No migration shim for the old `mma init` behavior (hard MAJOR rename, per D8 of the 2.0.0 spec).

## 4. Decisions (locked)

| # | Decision |
|---|----------|
| O1 | `mma init` = `AGENTS.md` generator; wizard renamed to `mma setup`. Hard rename, no alias. |
| O2 | Both commands are **LLM-driven**; the agent runs a focused session with a curated prompt. |
| O3 | `meet` writes **only** to global memory (`preferences.json`, `facts.md`) — never to the repo. |
| O4 | `init` writes **only** `<baseDir>/AGENTS.md`; existing file is improved **in place** (diff + confirm), never blindly replaced. |
| O5 | Onboarding sessions run with a **restricted tool allowlist** (see §7.2), not the default tool set. |
| O6 | `[Y/n]` offer appears after setup **only if a provider preflight succeeds**; otherwise a calm hint, no offer. |
| O7 | Every `meet` entry point (offer, `/meet`, `mma meet`) performs a **preflight**: `listModels` + a minimal chat probe (`max_tokens=1`), bounded timeout (default 3s, env-overridable). |
| O8 | `remember` writes are atomic per call — a mid-interview failure keeps confirmed entries, writes nothing else. |
| O9 | `/memory` is the single surface to view/edit memory; subcommands go through the handler map (rule #17). |
| O10 | All new strings go through `t()` with `en`+`ru` parity; all human output follows STYLE.md. |
| O11 | No new required config; onboarding has sane defaults. Optional knobs may be added later. |
| O12 | Onboarding sessions are logged to `session.jsonl` as `onboarding_*` events for observability. |

## 5. Command surface

| Purpose | CLI | REPL |
|---|---|---|
| Provider wizard | `mma setup` | `/setup` |
| Meet («Познакомимся») | `mma meet` | `/meet`, `/познакомимся` |
| AGENTS.md init | `mma init` | `/init` |
| Memory view/edit | — (optional `mma memory`) | `/memory …` |

- REPL commands register through the handler map (`src/cli/repl-commands.ts`, rule #17), with usage/aliases in `/help`.
- `mma meet` / `mma init` are one-shot wrappers over the same engine; they require a TTY for the interactive parts and otherwise print a hint (no silent no-op).
- Completion: `/memory` subcommands + preference keys; `/meet`, `/init`, `/setup` command names.

## 6. `meet` — «Познакомимся»

### 6.1 Flow

1. **Entry:** (a) `[Y/n]` offer after first-run setup (REPL process, `MMA_POST_SETUP=1`, TTY); (b) `/meet`; (c) `mma meet`.
2. **Preflight** (§8). Fail → calm hint, stop, nothing written.
3. **Interview session** with `MEET_SYSTEM_PROMPT`: the agent asks 1–3 questions per turn, adapts to answers, and persists each answer with the `remember` tool. Topics: name & reply language, tone/verbosity, tech stack & experience, working habits, hard "do not" rules (git, tests), goals.
4. **End:** when topics are covered or the user stops. Agent prints a compact `✓` summary of what was remembered.
5. **Bounds:** turn cap (default 8), `Esc` ends early (AbortError propagates, no fallback), user may answer empty to skip a question.

### 6.2 Tools

- Allowed: `remember`, `question`.
- Denied: all file/bash/web/browser tools. The interview must never touch the repository.

### 6.3 Persistence

- Structured answers → `remember category=preferences` (`key=value`).
- Free-form answers → `remember category=facts`.
- Files: `~/.mma/memory/preferences.json`, `~/.mma/memory/facts.md` (existing `MemoryStore`).
- No partial/garbage writes: only what the model explicitly confirms via `remember`.

### 6.4 Output (STYLE.md)

- Agent questions: `?` glyph (accent); user echo: `>` (accent); reasoning: `✦` (violet).
- `remember` actions: `◇` + `tool.friendly.remember` label, meta category (dim); a batch collapses to `◇ Запоминаю · N записей ✓`.
- Final summary uses `✓` (green) and `↳` (dim) detail lines. No boxes, no system tool names.

## 7. `init` — `AGENTS.md`

### 7.1 Flow

1. **Scan** the repo: project map / indexer (`mma map`) + key files (`package.json`, `tsconfig`, lockfile, CI configs, `README`, existing Cursor/Copilot rules, current `AGENTS.md`).
2. **Targeted questions** via `question` when the codebase cannot answer (e.g. non-obvious conventions, gotchas).
3. **Compose** sections: build/lint/test commands, architecture & non-obvious structure, project conventions, setup quirks/gotchas, references to existing instruction sources.
4. **Write**:
   - No `AGENTS.md` → create `<baseDir>/AGENTS.md`.
   - Existing `AGENTS.md` → **improve in place**: produce a proposed version, show a **diff**, ask for confirmation, then write. Never overwrite without confirmation.
5. **Budget check:** warn if the result exceeds the instructions budget (10% of `contextWindow`, existing overflow logic in `bootstrap.ts`).

### 7.2 Tools

- Allowed: `read_file`, `list_dir`, `glob`, `grep`, `project_map`, `question`, `write_file`, `edit_file`.
- Denied: `bash`, `delete_file`, `move_file`, network tools. `init` never runs project commands to "discover" them; it reads declared scripts.

### 7.3 Output

- Same chat style; file write is a `◇` mutate-category (magenta) line; diff rendered with the existing diff view. Confirmation via `question`.

## 8. Preflight & failure handling

### 8.1 Preflight

- Shared helper (extract `testChat`/health logic): `preflightProvider(config, { timeoutMs })`.
- Steps: `listModels` (free) → if empty/failed, provider is down; if models exist, minimal chat probe `max_tokens=1` to confirm the selected model is loaded and responds.
- Default timeout 3s (env override, e.g. `MMA_PREFLIGHT_TIMEOUT`); runs with a spinner; never a billed-heavy call.
- Used by: the post-setup offer gate, `/meet`, `mma meet`. Not by `/init` beyond the normal agent needs.

### 8.2 Failure matrix

| Scenario | Behavior |
|---|---|
| Provider down during `mma setup` | Setup already warns (yellow) and **saves config**; after re-exec the REPL preflight fails → offer is **skipped**, calm hint (`/provider check`, `mma provider check`). |
| `/meet` when provider down | One warning line + hint; nothing written; returns to prompt. |
| Model not loaded (provider up) | Same as down: warning + hint to load the model; nothing written. |
| Model dies mid-interview | Interview stops with an error line; already-confirmed `remember` entries are kept; hint to resume with `/meet`. |
| `Esc` during interview | Abort immediately; no summary; already-confirmed entries kept. |
| Non-TTY / `--json` | Interactive commands print a hint and exit non-zero; no blocking prompt. |

### 8.3 Example (RU)

```
⚠ Провайдер не отвечает — «Познакомимся» пока недоступно.
  ↳ Подними модель и вызови /meet. Ничего не записано.
```

```
> /meet
⚠ Не могу начать: lmstudio не отвечает (3s).
  ↳ Запусти модель и повтори /meet — ничего не записано.
```

## 9. `/memory`

- `/memory` — overview: `preferences` (key=value) + last entries per category.
- `/memory get <key>` — one preference.
- `/memory set <key> <value>` — write via `MemoryStore.setPreference`.
- `/memory unset <key>` — delete preference.
- `/memory find <query>` — search (thin wrapper over memory search / `recall`).
- `/memory forget <category> <n>` — remove one append-only entry.
- Handler map + usage + completion; i18n `repl.memory_*`.

## 10. Shared engine & files

```
src/modules/onboarding/
├── module.ts        # OnboardingModule (prompts + orchestration)
├── meet.ts          # runMeet(ctx) — interview session
├── init.ts          # runInit(ctx) — AGENTS.md session
├── prompts.ts       # MEET_SYSTEM_PROMPT, INIT_SYSTEM_PROMPT
└── preflight.ts     # preflightProvider()  (or re-export from providers/)
```

| File | Action |
|---|---|
| `src/modules/onboarding/*` | Create — engine, prompts, preflight |
| `src/modules/providers/preflight.ts` | Create — shared `preflightProvider` (extract from `setup.ts` `testChat` + `health.ts`) |
| `src/cli/commands.ts` | Modify — rename `init`→`setup`, add `init` (AGENTS.md) + `meet` |
| `src/cli/repl-commands.ts` | Modify — `/setup`, `/meet`, `/init`, `/memory` handlers |
| `src/cli/repl.ts` | Modify — post-setup `[Y/n]` offer, banner hints |
| `src/core/session-logger.ts` | Modify — `logOnboarding` (or generic event) |
| `src/i18n/{en,ru}.json` | Modify — parity strings |
| `tests/onboarding-*.test.ts` | Create — unit tests |
| `AGENTS.md`, `CHANGELOG.md` | Modify — document commands; 3.0.0 entry |

### 10.1 Test seams

- `AgentDeps` / `ToolContext.agentFactory` seam for a fake agent (vi.mock is process-global in Bun — do not use).
- `preflightProvider` accepts an injectable probe function.
- REPL `[Y/n]` gate reads an injectable preflight result.

### 10.2 Observability

- `onboarding_meet_start`, `onboarding_meet_done`, `onboarding_init_start`, `onboarding_init_done`, `onboarding_preflight` events → `session.jsonl`, visible in `session show`.

## 11. i18n

- New keys (en+ru parity): `cli.setup_*`, `cli.meet_*`, `cli.init_*`, `repl.meet_*`, `repl.init_*`, `repl.memory_*`, `onboarding.preflight_*`, `onboarding.fail_*`, `tool.friendly.remember`.
- System tool names never rendered; friendly labels only.

## 12. Testing

1. Unit (fake agent): interview persists prefs/facts; tool allowlist enforced; `init` creates new / improves in place; diff-confirm path; preflight down/up; mid-interview failure keeps confirmed entries.
2. `/memory` set/get/unset/find/forget round-trip.
3. `bun test` + `tsc --noEmit`.
4. Manual scenarios in `docs/agents/testing.md`: first-run offer, provider-down path, `/meet`, `mma init` on a repo with and without `AGENTS.md`.

## 13. Migration & versioning

- **3.0.0 MAJOR:** `mma init` semantics changed; wizard moved to `mma setup`. `mma init` no longer configures a provider.
- CHANGELOG entry (`Added`/`Changed`/`Removed`); AGENTS.md command table + docs updated.
- No data migration (memory format unchanged; `AGENTS.md` is a new artifact).

## 14. Three integration dimensions

1. **Real user:** clear first-run; explicit `[Y/n]`; reversible (`/memory` edits, `init` diff+confirm); calm errors with one hint; `en`+`ru`.
2. **Small model (Qwen3.5-9B, 32K–64K):** restricted tool sets, capped turns, short curated prompts, structured persistence via `remember`, no codebase risk in `meet`, no hanging preflight.
3. **Adjacent modules:** memory store, project map/indexer, agent loop & tool narrowing, session logger, output channel/STYLE, i18n, security (no writes outside the project / memory), updater/version, REPL handler map & completer.

## 15. Open questions

- Optional `mma memory` CLI mirror (parity with `/memory`) — deferred until requested.
- Whether `meet` should offer a deterministic fallback questionnaire when no model is available — deferred; current decision is a hint, not a fallback.
