# Web Auto-Update & MMART Reaction — design

Date: 2026-10-09
Status: implemented (branch `feat/updater-web-mascot`)

## Problem

Auto-update works only in the terminal. Three defects:

1. **`mma web` never starts the updater.** `runWeb` calls `bootstrap(...webBootstrapArgs())`
   with `exitOnComplete=true` (`src/cli/web-command.ts:65`), and `src/cli/main.ts:280`
   reads `const updater = exitOnComplete ? undefined : startAutoUpdate(config)`. The module
   is never constructed. `mma serve` is disabled the same way (`service-command.ts:46`).
2. **The web settings panel lies.** `controls.ts:235` renders all four `updater.*` keys in
   the `advanced.service` section, but none of them has any effect in web mode.
3. **`updater.checkOnStart` is a dead flag.** Declared in types/defaults/registry/i18n/UI and
   read nowhere; `runLoop()` always checks. The docs (`docs/agents/modules.md:358`,
   `versioning.md:228`, `mma-features-overview.md:378`) still claim it defaults to `true`,
   which stopped being true when both it and `autoInstall` flipped to `false`.

User-visible symptom that started this: "auto-update stopped working". Root cause was
different — local `package.json` was `2.37.0` while npm `latest` was `2.36.0`, so
`semverGt()` correctly reported no update. That is correct behavior, not a bug, but the
web surface was independently broken and invisible.

## Goals

- `mma web` checks npm for a newer version and tells the user in the UI.
- MMART (the mascot) reacts, so the notice is not a silent background fetch.
- The four `updater.*` toggles in the web panel become honest.
- No dead config keys.

## Non-goals

- No auto-install in web. `updater.autoInstall` stays `false` by default everywhere; the
  notice tells the user the exact command. `npm install -g` from a web server process is a
  bigger blast radius than from a terminal the user is watching.
- No new config keys. The existing four cover it.
- No update banner in the feed. The notice is a persistent chip in the footer plus a
  mascot state — no toast queue, no dismiss button to get wrong.

## Design

### 1. Delete `updater.checkOnStart`

Removes the only flag with no reader. `intervalMs: 0` already means "single check per
launch", and `enabled: false` already means "never check" — the flag had no third state to
express.

Files: `config/types.ts`, `config/defaults.ts`, `config/registry-extra.ts`, `cli/main.ts`
(structural type of `startAutoUpdate`), `webui/assets/js/settings/controls.ts`,
`i18n/{en,ru}.json`, three test fixtures (`tests/core/agent*.test.ts`).

Migration: an existing `~/.mma/updater.json` keeps the field; it is simply ignored by
`loadConfig` merge (unknown keys are preserved but unread). No write migration needed —
this matches how retired keys have been handled elsewhere.

### 2. Start the updater in web

`startWebUi` gains an optional `updater?: UpdateNotifier` dep. It is created by
`web-command.ts`, which already holds `config` from `bootstrap`.

Refactor: extract the construction from `startAutoUpdate` into a reusable factory
`createUpdater(config, hooks)` in `src/modules/updater/`, used by both `cli/main.ts` and
`cli/web-command.ts`. `startAutoUpdate` keeps its dev-entry guard and terminal logging;
the web path reuses the same guard so a `bun run mma web` checkout still never
`npm install -g`s over the user's global install.

`exitOnComplete` no longer disables the updater. That flag exists to give the interactive
stdin prompt ownership of the terminal; the updater never touches stdin (its only I/O is
a `fetch` and `execFile` with `windowsHide`). Removing the coupling is correct for both
`web` and `serve`.

### 3. SSE notification

New event type `update`:

```
{ type: "update", ts, phase: "available" | "installed" | "failed", current, latest, error? }
```

`available` fires once per check that finds a newer version; `installed`/`failed` only
when `autoInstall` is on. Broadcast to all clients via the existing `broadcast()` — the
event is global, not per-session, so it carries no `sessionId` (same as `index`/`files`).

The check is still fire-and-forget: `start()` returns immediately, so the npm fetch never
delays the server bind.

### 4. MMART reaction

New face state `update` in `loader.ts`:

- `FACE_CLASS.update = "c-active st-update sparkle"` — sparkle decoration, active color,
  no `.track`/`.poke` (the mascot should not follow the cursor while advertising an update).
- `loaderStateFor`: `case "update": return "update"`. Unlike `usage`/`state`/`config`,
  this event *does* reach `faceEvent` — it is a real user-facing notice, not background
  bookkeeping. `app.ts` adds `es.addEventListener("update", () => faceEvent("update"))`.
- CSS `st-update` in `styles.css`: slow bob + `spark` visible, `prefers-reduced-motion`
  already kills animations globally.

The composer face returns to idle on the next turn boundary, so the mascot does not stay
permanently excited.

### 5. Footer chip

`HostStateSnapshot` gains `updateAvailable?: { current, latest }`. It rides the existing
`state` snapshot (event-sourced state rule: no new SSE type for a persistent fact), and
`footer.ts` renders a chip next to the version:

```
◇ dir /path · ↑ 2.37.0 · mma 2.36.0
```

`title` carries the install command. The chip shows while `latest > current`; after the
process restarts on the new version the probe finds nothing and the chip is gone.

### 6. Hint instead of silent notify

`updater.available` currently says "Run `npm install -g …` to upgrade." That stays, plus a
pointer to the auto-install switch, so the notice is actionable from either surface.

## Alternatives rejected

- **Reuse the `plugins` SSE event shape** for update state — no, unrelated domain, and the
  payload differs.
- **Toast in the feed** — needs a dismiss/queue lifecycle and a second persistence path.
  The footer chip is persistent and needs no state.
- **Make `checkOnStart` work instead of deleting it** — its two neighbors already cover both
  states it could express; adding a third spelling of "check" is the exact failure mode
  this task removes.

## Tests

- `tests/updater-module.test.ts` — updated fixture without `checkOnStart`.
- `tests/updater-web-notify.test.ts` — the factory builds a module that emits `available`,
  honors the dev-entry guard, and broadcasts through the injected sink.
- `tests/webui-update-chip.test.ts` — chip renders from a snapshot, disappears when absent.
- `tests/webui-loader.test.ts` — extended: `update` maps to the new state and is not
  classified as a background broadcast.
- Guard in `tests/webui-assets.test.ts` — `updater.checkOnStart` absent from `controls.ts`
  and from both i18n dictionaries.