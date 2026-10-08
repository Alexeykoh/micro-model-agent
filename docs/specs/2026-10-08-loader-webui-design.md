# Loader Faces in the Web UI — Design

- **Status:** draft → implementation
- **Date:** 2026-10-08
- **Scope:** `mma web` frontend (`src/modules/webui/assets/**`)
- **Prototype:** `tmp/loader/app.html` (18 states, common `loader.css` + `loader.js`)

## Goal

Give the agent a single, human, recognizable "presence" in the web UI: a small
squircle **face with animated eyes** that reflects what the agent is actually
doing. The same component drives:

1. the **first-run / boot loading screen** (the original reference image),
2. the **in-turn busy indicator** in the feed,
3. the **activity rail** above the composer,
4. the **first-run setup wizard** (provider test / scan / model load),
5. **session loading** and tab/`Trace` affordances (later phases).

No new dependency, no emoji-in-chat (STYLE.md), no change to SSE/REST contracts.

## Non-goals

- Terminal REPL / one-shot output (STYLE.md glyphs stay).
- Replacing `session.jsonl` semantics or server events.
- Sound, canvas, WebGL. Pure DOM + CSS animations.
- Reworking the feed's event routing.

## Component

One face = one `<span class="mdl">` with two eyes `.eye`. Extra effects
(`.orb`, `.key` particles, `.q`, `.star`, `.fly`, `.dust`) are children shown
only for their state (CSS, not JS toggling).

```html
<span class="mdl sm c-recon st-read">
  <span class="eyes"><i class="eye left"></i><i class="eye right"></i></span>
</span>
```

- **Size** via `--s` (`sm:22 lg:76`, default 64). Eyes/layout scale from it.
- **Color** via `.c-*` (recon/mutate/exec/ok/warn/err/active/dim) → sets
  `--face-c`/`--eye-c`. Palette from existing tokens.
- **State** via `.st-*` → eyes/body animation + extras.
- **Idle** (`.track`) follows the cursor and the body tilts (`--ex/--ey/--tilt`
  set by `loader.ts`); `.poke` = click anywhere → blink once (guarded).
- Everything killed by the existing `prefers-reduced-motion` block.

### State table (18)

| state class | UI meaning | motion |
|-------------|-----------|--------|
| `track` (+`poke`) | idle, waiting for you | eyes track cursor, body tilt, breathe, click-blink |
| `st-think` | thinking / reasoning | gaze arc upward, slow blink |
| `st-read` | reading file/dir | eyes sweep lines, step down |
| `st-find` | search (grep/glob/map) | squint + zig-zag + body ping |
| `st-web` | web search/fetch | squint + eyes follow orbiting `@` |
| `st-edit` | editing file | narrow eyes, darting + keystroke particles |
| `st-type` | composing answer | eyes down, rhythmic key taps |
| `st-create` | writing new file | draws line, file flies off |
| `st-run` | running command | springy launch + dust |
| `st-tests` | running tests | fast needle scan + micro pulse |
| `st-compact` | compaction | horizontal squeeze |
| `st-plan` | MoE planning | hops across a 2×2 grid |
| `st-ask` | question / approval | head shake + wide eyes + `?` |
| `st-done` | success | bounce + spark, click → blink |
| `st-error` | failure | sags + `*` pulse above |
| `st-stop` | interrupted | power-down, deflate + flash |
| `st-queued` | queued task | pendulum + occasional glance |
| `st-boot` | connecting | body = spinning dashed circle |

## Event → state mapping

`phase`/`tool_start`/`tool_end`/`turn_end`/`error` are already on the SSE bus.

| signal | state |
|--------|-------|
| tab/`state.busy` + no text/tool yet, reasoning stream | `st-think` |
| `tool_start name=read_file\|list_dir\|file_info` | `st-read` |
| `…grep\|glob\|project_map\|chunk_query\|history\|recall` | `st-find` |
| `…web_search\|web_fetch\|download_file` | `st-web` |
| `…write_file\|edit_file\|move_file\|delete_file\|create_dir\|attach_image` | `st-edit` / `st-create` (write vs create) |
| `…bash\|pipeline_run\|process_wait\|browser` | `st-run` |
| `…subagent\|mcp_call` | `st-run` (spinner-like) |
| plan present (MoE) + planning | `st-plan` |
| `text` streaming | `st-type` |
| `question` | `st-ask` |
| `turn_end success:true` | `st-done` |
| `turn_end success:false` / `error` | `st-error` |
| interrupt (Esc) | `st-stop` |
| queued slot | `st-queued` |

Mapping lives in one pure function `loaderStateFor(evt)` (`loader.ts`) so feed
and rail cannot diverge.

## Integration points

1. **Boot / loading screen** — `index.html` gets `#bootSplash` (fixed overlay,
   a 3×3 face grid + caption + progress). Removed by `app.ts` after
   `loadI18n` + first `refresh()`; also removed if `MmaSetup` takes over.
2. **Feed busy** — `feed/core.ts showBusy()` replaces the `✦` spinner with a
   face; `feed/stream.ts onPhase/onText/onToolStart` update its class via
   `setBusyState()`. `clearBusy` unchanged.
3. **Activity rail** — `rail.ts` prepends a small face before the phase label;
   `railEvent` sets its state from the tool name. Replaces the `✦` in `labEl`.
4. **Setup wizard** — `setup.ts` shows an inline face while
   `/api/setup/{scan,models,test}` is in flight (`st-boot`/`st-find`/`st-run`),
   and the full boot splash during the final `POST /api/setup`.
5. **Sessions / sidebar** — tab `.dot` keeps its glyph; the `Session` pane's
   "loading" (`setSessionLoading`) shows a face (later phase).

## Config

`ui.loader` (default `true`) — master switch; when `false`, fall back to the
current `✦` spinner everywhere. No per-state config. Speed multiplier is a
debug-only `?loaderSpeed=` URL param.

## i18n

Reuse existing strings where possible. New keys (en+ru): `web.loader.boot`,
`web.loader.connecting`, `web.setup.testing`. Nothing user-facing hard-coded.

## Accessibility & motion

- Face is decorative: `aria-hidden="true"`; the textual phase label remains the
  accessible status (`role="status"`).
- All animations are opacity/transform-only and disabled under
  `prefers-reduced-motion: reduce` (global kill-switch already present).

## Files touched

- `src/modules/webui/assets/js/loader.ts` — component + `loaderStateFor`.
- `src/modules/webui/assets/styles.css` — `.mdl` component + boot splash.
- `src/modules/webui/assets/index.html` — `#bootSplash` markup.
- `src/modules/webui/assets/app.ts` — boot splash lifecycle; `.mdl.track` cursor.
- `src/modules/webui/assets/js/feed/core.ts` — `showBusy` face.
- `src/modules/webui/assets/js/feed/stream.ts` — `onPhase`/`onText` state.
- `src/modules/webui/assets/js/rail.ts` — rail face + mapping.
- `src/modules/webui/assets/setup.ts` — wizard faces.
- `src/i18n/{en,ru}.json` — new keys.

## Tests

- `tests/webui-loader.test.ts` — `loaderStateFor` mapping table; face DOM
  builder; `setBusyState` swaps classes without recreating eyes.
- Extend `tests/webui-assets.test.ts` guards — `#bootSplash` present, `.mdl`
  CSS present, no emoji in chat strings.
- `tsc -p tsconfig.frontend.json` + `bun run quality`.

## Rollout

1. Component + CSS + state mapper (no wiring).
2. Boot splash.
3. Feed busy + rail.
4. Setup wizard.
5. Sessions/sidebar + Trace.
