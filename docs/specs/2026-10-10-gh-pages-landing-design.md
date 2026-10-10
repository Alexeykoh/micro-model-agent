# MMA Landing Page (GitHub Pages) — Design

- **Status:** approved → implementation
- **Date:** 2026-10-10
- **Branch:** `feat/gh-pages-landing`
- **Scope:** new static folder `gh-pages/` in the repository root
- **Sources:** `docs/mma-features-overview.md`, `docs/design/ui/STYLE.md`,
  `src/modules/webui/assets/{styles.css,js/loader.ts}` (mascot MMART)

## Goal

A single public landing page, published via GitHub Pages, that lets a developer
looking for an agent for **local small models** understand — in one scroll —
what MMA is, why it exists, and how to install it.

The page is an **entry point**, not a replacement for the README or the docs.

## Non-goals

- No framework, no build step, no bundler, no server-side code.
- Not a documentation site: no page-per-feature, no search, no routing.
- No real product screenshots (a CSS mini-mockup of the chat is used instead).
- No analytics, no trackers, no external CDN dependencies (works offline).
- No change to `src/**`, the build pipeline, or any runtime contract.

## Audience & success criteria

- **Audience:** developers who already have a local backend (LM Studio/Ollama)
  and are evaluating MMA against hosting a large model in the cloud.
- **Success:** visitor can (a) state what MMA does, (b) copy the install
  one-liner, (c) reach GitHub / docs / releases — without reading the README.

## Files

Static assets, no build (`gh-pages/` is served as-is by GitHub Pages):

```
gh-pages/
  index.html    — markup; section anchors
  styles.css    — design tokens (dark + light), layout, mascot component
  mascot.css    — vendored subset of the webui `.mdl` face component
  app.js        — theme + language state, mascot behaviour (cursor + scroll)
  i18n.js       — `ru` / `en` dictionaries, `t()` helper
  favicon.svg   — the face as an icon
```

## Page structure (top → bottom)

1. **Nav** — brand (small face + `MMA`), section links, language toggle
   (`RU`/`EN`), theme toggle (☾/☀), GitHub link. Sticky.
2. **Hero (split)** — left: headline + one-line pitch + `Install` / `Docs`
   buttons; right: large live MMART face (tracks the cursor, blinks, reacts to
   click).
3. **Why** — the problem: small models in a 32K–64K window lose the thread;
   MMA is the harness that keeps them on task. Short, 3 bullets.
4. **Quick start** — the install one-liner + a note that a local backend
   (LM Studio / Ollama) is all you need. Copy-to-clipboard on the code block.
5. **Capabilities** — a grid of cards: tools & on-demand narrowing, context
   budget & compaction, plan & execution guarantees, MoE, memory, safety, web.
   Each card carries a category color and, on hover, drives the mascot state.
6. **Two frontends** — terminal and `mma web`; includes the CSS mini-mockup of
   a chat transcript (STYLE.md glyphs: `◇`, `✦`, `⟡`, `↳`). Side by side.
7. **`mma serve`** — the HTTP service mode for external systems; one short
   paragraph + a fenced request example.
8. **Philosophy / boundaries** — what the agent is (universal harness, not a
   code-only agent) and what it deliberately does not do.
9. **Footer** — GitHub, README, docs, releases, MIT license, current version.

## Internationalization

- Languages: **`ru`** and **`en`**, full parity.
- Initial language: `navigator.language` (falls back to `en`).
- Toggle in the nav; the choice is persisted in `localStorage` under
  `mma-lp-lang`.
- All user-facing strings live in `i18n.js` and are applied via a `t(key)`
  helper; `data-i18n` attributes on elements. No hard-coded copy in markup.
- `<html lang>` and `<title>` update on switch.

## Theming

- Themes: **`dark`** (default content) and **`light`**.
- Initial theme: `prefers-color-scheme`; toggle in the nav; persisted in
  `localStorage` under `mma-lp-theme`.
- Applied via `body.light` (mirrors the webui contract: every `:root` token has
  a `body.light` override). Tokens are copied from
  `src/modules/webui/assets/styles.css` so the page visually matches the app.

## Mascot (MMART)

- The face is the **existing `.mdl` component** (squircle + two `.eye`), with
  colors `.c-*` and states `.st-*`. A **subset** is vendored into `mascot.css`
  and driven by a small port of `loaderStateFor`:
  `track` (idle), `think`, `read`, `find`, `run`, `edit`, `web`, `done`,
  `error`. Not all 18 states.
- **Hero face:** `track` by default (eyes follow the cursor, body tilt), blinks
  on click.
- **Scroll companion:** a small face that follows the reader down the page and
  switches state per section: `why → think`, `quickstart → run`,
  `capabilities → read`, `frontends → web`, `serve → run`, `footer → done`.
- **Capability hover:** hovering a card sets the corresponding state
  (`write_file → edit`, `memory → think`, …); leaving returns to `track`.
- Decorative only: `aria-hidden="true"`; accessible status stays in text.
- All motion is opacity/transform-only and disabled under
  `prefers-reduced-motion: reduce` (no state cycling; a single static `done`
  face).

## Styling rules

- STYLE.md is the canon for content and glyphs: no boxed panels in body copy,
  semantic colors, honest one-line statuses. Marketing surfaces (hero gradient,
  capability cards) are allowed — this is not chat output.
- Category colors follow STYLE.md: recon = cyan, mutate = magenta,
  exec = blue, meta = dim.
- Responsive: single column below ~900px; nav collapses; hero stacks
  (face above text); the mini-mockup goes full width.
- No external fonts — system font stack only.

## Publication

- Folder `gh-pages/` on branch `master`.
- GitHub Pages runs in **GitHub Actions** mode (`build_type: workflow`): the branch
  deploy only accepts `/` or `/docs` as the folder, and `/docs` is the specs tree, so
  the site is uploaded as a Pages artifact by `.github/workflows/pages.yml`
  (checkout → `configure-pages` → `upload-pages-artifact` with `path: gh-pages` →
  `deploy-pages`). Trigger: push to `master` touching `gh-pages/**`.
- Live URL: https://alexeykoh.github.io/micro-model-agent/
- Documented in `AGENTS.md` (new "Landing Page" section) and `CHANGELOG.md`
  (MINOR: new deliverable).

## Verification

- Manual browser pass: both themes × both languages, desktop + ~390px width,
  and `prefers-reduced-motion: reduce`.
- The page must work opened directly from disk (`file://`) — no absolute paths,
  no fetch that breaks offline.
- `bun run quality` is **not** affected (`gh-pages/` is outside `src/`); confirm
  it stays green.
- Optional lightweight smoke test: assert `gh-pages/index.html` exists, links a
  local `styles.css`/`app.js`/`i18n.js`, and contains both language dictionaries.

## Risks

- **Mascot drift:** vendoring the face duplicates CSS from the webui. Accepted:
  a landing page must not couple to the app build. The `mascot.css` header
  records the source and version it was copied from.
- **Breakage of `docs/` Pages:** avoided by publishing from `/gh-pages`, not
  `/docs`.
