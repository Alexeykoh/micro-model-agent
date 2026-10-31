# Loader Faces in the Web UI — Design

- **Status:** implemented (Canvas 2D renderer since 2026-10-31)
- **Date:** 2026-10-08 (canvas amendment: 2026-10-31)
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
- Sound, WebGL. Pixels are Canvas 2D (§ Canvas renderer); DOM + CSS keep only
  layout, the greeting bubble and the state-class contract.
- Reworking the feed's event routing.

## Component

One face = one `<span class="mdl has-canvas">` that sizes/positions a single
`<canvas>`; `mascot-canvas.ts` draws body, eyes and props. The wrapper keeps
the state classes and the greeting bubble, so every call site and test hook
(`createFace`, `setFaceState`, `.mdl.tip`, `.track`/`.poke`) is unchanged.

```html
<span class="mdl has-canvas sm c-recon st-read">
  <canvas class="mdl-cv"></canvas>
  <span class="mdl-tip"></span>
</span>
```

- **Size** via `--s` (`sm:22 lg:76`, default 64). The canvas is 180% of the
  wrapper and centred, so the body fills ~90% of the old face box and effects
  live in the surrounding ring (same visual footprint as the CSS extras).
- **Color** via `.c-*`: the renderer reads the live CSS tokens and enforces
  eye ≥ 4.5:1, face ≥ 3:1 (dim stays low-contrast by design and keeps its
  border).
- **State** via `.st-*` → `STATE_CFG` (eyes + pose + prop + effects).
- **Idle** (`.track`) follows the cursor through `mascotLookAt`; `.poke` =
  blink once via `mascotPokeAll`.
- **Reduced motion**: a representative static frame, no rAF.

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

## Canvas renderer (2026-10-31)

The renderer moved from CSS keyframes to Canvas 2D without changing the public
contract. Modules:

- `mascot-canvas.ts` — attach API, shared rAF loop, spring pose, reduced motion,
  instance pruning.
- `mascot-pose.ts` — one table: state → eyes/pose/lean/props/effects + body
  dynamics and blink.
- `mascot-draw.ts` — body, eyes, composition, transition crossfade.
- `mascot-fx.ts` / `mascot-props.ts` / `mascot-props-work.ts` — ambient effects
  and semantic props.
- `mascot-palette.ts` — CSS-token palette + contrast guard.
- `mascot-types.ts` / `mascot-util.ts` — shared types and helpers.

Invariants:

1. **Face is never occluded.** Foreground props/effects are clipped by an
   even-odd hole of the body silhouette; they may sit flush, never overlap.
2. **One loop for every face.** `requestAnimationFrame` is shared; offscreen
   faces pause via `IntersectionObserver`; removed faces are pruned.
3. **DPR ≤ 2**, transparent canvas, no background fill.
4. **Level of detail by size**: `< 50 px` body + eyes only; `50–90 px` adds
   ambient effects; `≥ 90 px` adds props. The composer (40 px) stays clean.
5. **Contrast**: eye ≥ 4.5:1, face ≥ 3:1, measured from the live tokens.
6. **State change** blends colours, body dynamics, eye shape and effects over
   0.36 s; the spring carries the current velocity.
7. **Corners follow the theme**: the body radius is read from the wrapper's
   computed `border-radius`. Seasonal themes set `border-radius: 0 !important`
   on every element, so the canvas renders a square body there instead of
   hard-coding the squircle.
8. **Landing page**: `gh-pages/mascot-canvas.js` is generated from these modules
   by `bun run build:landing-mascot` (no build step at serve time) and exposed
   as `window.MMART`; `tests/arch/landing-mascot.test.ts` guards the wiring.



- Face is decorative: `aria-hidden="true"`; the textual phase label remains the
  accessible status (`role="status"`).
- All motion is drawn on canvas and disabled under
  `prefers-reduced-motion: reduce` (the renderer draws a static frame and stops
  the rAF loop).

## Files touched

- `src/modules/webui/assets/js/loader.ts` - component + `loaderStateFor`.
- `src/modules/webui/assets/js/loader-states.ts` - `FaceState`/`FaceSize` +
  `FACE_CLASS`.
- `src/modules/webui/assets/js/mascot-*.ts` - canvas renderer (see above).
- `src/modules/webui/assets/styles.css` - `.mdl` wrapper + canvas sizing.
- `src/modules/webui/assets/index.html` — `#bootSplash` markup.
- `src/modules/webui/assets/app.ts` — boot splash lifecycle; `.mdl.track` cursor.
- `src/modules/webui/assets/js/feed/core.ts` — `showBusy` face.
- `src/modules/webui/assets/js/feed/stream.ts` — `onPhase`/`onText` state.
- `src/modules/webui/assets/js/rail.ts` — rail face + mapping.
- `src/modules/webui/assets/setup.ts` — wizard faces.
- `src/i18n/{en,ru}.json` — new keys.

## Tests

- `tests/webui-loader.test.ts` - `loaderStateFor` mapping table; canvas face
  builder; `setFaceState` swaps classes without recreating the canvas.
- Extend `tests/webui-assets.test.ts` guards — `#bootSplash` present, `.mdl`
  CSS present, no emoji in chat strings.
- `tsc -p tsconfig.frontend.json` + `bun run quality`.

## Rollout

1. Component + CSS + state mapper (no wiring).
2. Boot splash.
3. Feed busy + rail.
4. Setup wizard.
5. Sessions/sidebar + Trace.
