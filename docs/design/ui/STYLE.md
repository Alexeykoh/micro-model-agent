# MMA Chat UI Style Guide

Design language for the agent's human-facing chat output. Applies to the REPL and
one-shot mode. It does **not** change the GUI system: everything still flows through
`OutputChannel` / `OutputBus` and is styled with `picocolors` (`src/ui/colors.ts`).

Reference mockup: [`mockup-chat-en-ru.html`](./mockup-chat-en-ru.html) — full transcript,
English left / Russian right.

## Goal

Make the agent output calm, scannable and pleasant, without hiding information the
developer needs. Reduce noise by default; keep detail one keystroke away.

## Core principles

1. **No boxes, no panels.** Only lines, indentation and glyphs. No drawn frames,
   no card borders, no table grids. Replaces current uses of `box()`, code-block
   boxes and box-drawing tables.
2. **Never show system tool names.** `read_file`, `bash`, `lsp_check`, … never appear
   in the UI in any locale. Always render the localized label from `tool.friendly.*`.
   Arguments (paths, commands, queries) are content and stay.
3. **Quiet by default, detail on demand.** One line per action. Metrics once per turn.
   Details behind `/verbose`, `--verbose`, or `Ctrl+O` (reprint of the last block).
4. **One visual language.** Shared glyph set and semantic color roles; no ad-hoc
   colors per module.
5. **Character without noise.** Status lines speak in short, human phrases; no
   emoji spam, no exclamation walls, no fake enthusiasm.
6. **Alive, not busy.** Spinner and progress update in place; no scrolling status spam.
7. **Errors are calm.** Raw model-facing recovery directives never reach the user.
   A failure is one summary line plus at most one actionable hint.

## Glyph vocabulary

| Glyph | Meaning |
| ----- | ------- |
| `◇` | an action (localized tool label follows) |
| `✓` | success |
| `✗` | failure |
| `⚠` | warning / non-fatal |
| `✦` | reasoning / thinking |
| `?` | the agent asks the user something |
| `↵` | user input echoed |
| `↳` | detail / recovery hint |
| `│` | continuation of a grouped run |
| `▰▱` | progress bar |
| `⟡` | metric summary line |
| `⟳` | compaction / refresh |

Arrows (`→`, `→`) may appear inside content, never as status markers.

## Color roles

Semantic, not decorative. Colors come from `pc` and are only emitted when the
terminal supports color (existing TTY gate is kept).

| Role | Use |
| ---- | --- |
| accent (blue) | the user prompt marker, links |
| success (green) | success marks, positive deltas |
| warn (yellow) | warnings, protected paths, soft blocks |
| error (red) | real failures only — never for soft guards or security prompts |
| dim / faint | chrome: banner, metrics, hints, paths, timestamps |
| text (default) | message body and content |

The action glyph `◇` keeps one shape; its **color encodes the tool category**
(never an outcome):

| Category | Color | Tools |
| -------- | ----- | ----- |
| recon (read/search) | cyan | `read_file`, `list_dir`, `glob`, `grep`, `file_info`, `project_map`, `chunk_query`, web, history, recall, process list/log |
| mutate | magenta | `write_file`, `edit_file`, `create_dir`, `delete_file`, `move_file`, `attach_image` |
| execute | blue | `bash`, `process_kill`, `pipeline_run`, `browser`, `download_file`, `subagent`, `mcp_call` |
| meta | dim | `plan`, `todo`, `verify`, `lsp_check`, `enable_tools`, `set_thinking`, `load_skill`, `remember` |

Per-tool emoji icons are not rendered.

Security blocks and protected-path prompts are **warnings (yellow)**, not errors.
Raw `[SECURITY BLOCKED]` text is model-facing and must not reach the chat.

## Verbosity levels

| Level | Default output | Extras |
| ----- | -------------- | ------ |
| `quiet` | one line per action; grouped runs summarized (`│ N actions ✓`); metrics once per turn | details via `/verbose` + `Ctrl+O` |
| `normal` | action lines + short result summaries | — |
| `verbose` | full per-action detail, file lists, raw-ish diagnostics | (existing `ui.verbose` becomes this level) |

The agent's *cognitive* guidance (nudges, recovery directives, `Hint:` blocks) stays
in the model context and never renders in the chat; only a one-line summary does.

## Message patterns

```
start:    qwen3.5-9b · lmstudio · 32K · system prompt 2.1K
          /work/landing · plugins 2 · mcp 1 · session a1f2

prompt:   > <user text>

thinking: ✦ thinking · 1.8s · /reasoning — show
action:   ◇ <label> <args> ✓ <meta>
detail:     ↳ <detail>
metric:   ⟡ 6.2K tok · 18% · 0.4¢
warn:     ⚠ <what> — <hint>
error:    ✗ <what> — <short cause>
          ↳ <one actionable hint>
```

## Localization

- All user-facing strings go through `t()`; `en` and `ru` stay in parity.
- Tool labels use `tool.friendly.*`; system names are added only as a fallback when
  a friendly label is missing.
- First-line user messages are short, neutral, present tense ("Reading file",
  "Чтение файла").

## Non-goals

- No TUI/full-screen redesign, no alternate rendering engine.
- No change to `session.jsonl` schema or model-facing output format.
- No new required config; the style is the default, toggles are opt-in.
- `--json` output is a machine contract and is unchanged.

## Implementation touchpoints

| Area | File |
| ---- | ---- |
| Colors / tokens | `src/ui/colors.ts`, new `src/ui/theme.ts` |
| Main renderer | `src/ui/renderer.ts` |
| Markdown / code / errors | `src/ui/md-formatter.ts` |
| Boxes / dividers / tables | `src/ui/box.ts` (wizard only), `src/ui/table.ts` |
| Spinner / progress | `src/ui/spinner.ts` |
| Plan checklist | `src/ui/plan-view.ts` |
| REPL banner / status | `src/cli/repl.ts` |
| Verbosity plumbing | `src/ui/renderer.ts`, `src/cli/repl-commands.ts`, `src/cli/main.ts` |
| Tool labels | `src/i18n/{en,ru}.json` (`tool.friendly.*`) |
| Tool-name display | `src/ui/renderer.ts` (`toolStart`/`toolEnd`) |
