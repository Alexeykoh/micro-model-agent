# GitHub Releases Distribution & Bootstrap Installer — design

Date: 2026-10-09
Status: proposed (branch `feat/bootstrap-installer`)

## Problem

MMA is distributed only as an npm package (`micro-models-agent`). Installing it requires a
package manager (`npm`) and, for full features, a Bun runtime: `bin/mma.mjs:24-36` re-executes
itself under Bun when Bun is on `PATH`, and degrades (no clipboard image paste, Windows LSP via
`npx.cmd`, on-the-fly TS transpile) when only Node is present. The project is going open source on
GitHub, and the intended user may have **nothing but an operating system** — no Node, no npm, no
Bun. npm is to be abandoned entirely: not published to, not used at install, not used by the
in-app updater.

This is a distribution problem, not a runtime problem: the harness itself works under Bun on all
three platforms. What is missing is a source of prebuilt, self-contained packages and a bootstrap
that installs one with a single command.

## Goals

- A user with a stock Windows / macOS / Linux machine installs `mma` with **one shell one-liner**,
  no pre-installed runtime.
- The downloaded package contains **everything** the agent needs (Bun runtime, app bundle,
  production dependencies, web assets). Full Bun-backed feature set after install.
- **No npm anywhere** in the install path or in the in-app updater.
- Re-running the one-liner updates to the latest release (idempotent); the previous version stays
  on disk for rollback.
- Primary development is the public GitHub repo; the existing Gitea server is retained only as a
  historical remote.

## Non-goals

- **No compiled single-file binary.** `bun build --compile` would require refactoring the
  web-asset loader (`src/modules/webui/assets.ts:16-23` reads `index.html` / `css` / `js/**` from
  disk relative to `dist/`) into embedded imports, plus separate Playwright handling. The tarball
  bundles a Bun runtime instead and ships the app as-is. A compiled binary can supersede this
  later without changing the entry point.
- **No OS-native installer** (`.msi` / `.pkg` / `.deb`), no menu shortcuts, no managed
  uninstaller. Removal is deleting `~/.mma`.
- **No bundled Playwright browser.** `playwright` (package) ships in the tarball; Chromium is
  downloaded on first browser-tool use via the existing path (`environment.ts:210`).
- **No code signing** in v1. macOS Gatekeeper / Windows SmartScreen will warn on unsigned
  binaries; documented as a known limitation, revisited later.
- **No npm-registry fallback.** Once the first GitHub release is verified working, the npm package
  is deprecated and unpublished where allowed (a separate, explicit step).

## Design

### 1. Repository & licensing

- Source of truth: public GitHub `Alexeykoh/micro-model-agent`, default branch `master`.
- License: **MIT** (`LICENSE` at repo root; reference from `package.json`).
- The Gitea remote is kept locally as `gitea` (history only); GitHub is `origin`.
- CI moves from `.gitea/workflows/quality.yml` to `.github/workflows/`.

### 2. Release pipeline (GitHub Actions)

Workflow `.github/workflows/release.yml`, triggered on a pushed tag `vX.Y.Z`:

1. Matrix, one runner per target (Bun binary is platform-specific):

   | target        | runner              |
   | ------------- | ------------------- |
   | `win-x64`     | `windows-latest`    |
   | `mac-arm64`   | `macos-14`          |
   | `mac-x64`     | `macos-13`          |
   | `linux-x64`   | `ubuntu-latest`     |
   | `linux-arm64` | `ubuntu-24.04-arm` (public-repo arm runner) |

2. On each runner: `bun install` → `bun run build:prod` (produces `dist/main.js` + `dist/assets`)
   → install **production** deps only → assemble the tarball (section 3) including that runner's
   own `bun`/`bun.exe`.
3. Upload `mma-<os>-<arch>.tar.gz` as a GitHub Release asset for the tag.
4. One extra job builds `latest.json` (section 4) from the per-platform `sha256`/`size` and uploads
   it to the same release.

A second workflow `.github/workflows/quality.yml` runs the existing quality gate (`bun run
quality`) on push/PR — the same checks the Gitea workflow ran.

Asset names are **versionless** (`mma-win-x64.tar.gz`) so `releases/latest/download/<asset>`
resolves stably; the version lives in `latest.json` and in the release tag.

### 3. Artifact layout

Tarball contents (root-relative):

```
runtime/bun(.exe)        # the platform Bun, as built/downloaded on that runner
app/main.js              # dist/main.js
app/assets/**            # prebuilt web assets + vendor js/css
app/node_modules/**      # production dependencies (incl. playwright, external in the bundle)
VERSION                  # e.g. 2.41.0
```

Installed layout under `~/.mma`:

```
~/.mma/
  versions/<version>/    # extracted tarball
  current -> versions/<version>   # symlink (junction/dir-copy on Windows)
  bin/mma(.cmd)          # launcher shim (added to PATH)
```

Launcher (unix `bin/mma`): `exec "$MMA_HOME/current/runtime/bun" "$MMA_HOME/current/app/main.js" "$@"`.
Windows `bin/mma.cmd`: `@"%USERPROFILE%\.mma\current\runtime\bun.exe" "%USERPROFILE%\.mma\current\app\main.js" %*`.
`MMA_HOME` defaults to `~/.mma`.

### 4. Manifest `latest.json`

Single source of truth for both the bootstrap and the updater:

```json
{
  "version": "2.41.0",
  "releasedAt": "2026-10-09T12:00:00Z",
  "artifacts": {
    "win-x64":     { "url": "mma-win-x64.tar.gz",     "sha256": "…", "size": 0 },
    "mac-arm64":   { "url": "mma-mac-arm64.tar.gz",   "sha256": "…", "size": 0 },
    "mac-x64":     { "url": "mma-mac-x64.tar.gz",     "sha256": "…", "size": 0 },
    "linux-x64":   { "url": "mma-linux-x64.tar.gz",   "sha256": "…", "size": 0 },
    "linux-arm64": { "url": "mma-linux-arm64.tar.gz", "sha256": "…", "size": 0 }
  }
}
```

`url` is relative to the manifest's base (the release's `download/` directory). Anonymous, stable
URL: `https://github.com/Alexeykoh/micro-model-agent/releases/latest/download/latest.json`.

### 5. Bootstrap scripts

Two scripts in the repo, served from `raw.githubusercontent.com`:

- `scripts/install.sh` — macOS / Linux
- `scripts/install.ps1` — Windows (PowerShell 5.1+)

One-liners:

```powershell
irm https://raw.githubusercontent.com/Alexeykoh/micro-model-agent/master/scripts/install.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/Alexeykoh/micro-model-agent/master/scripts/install.sh | bash
```

Shared behaviour:

1. Detect OS and arch; map to a manifest key (`win-x64`, `mac-arm64`, …). Unsupported → clear
   error, exit 1.
2. Fetch `latest.json` from `$MMA_INSTALL_BASE` (default:
   `https://github.com/Alexeykoh/micro-model-agent/releases/latest/download`).
3. Download the artifact for the platform; verify `sha256`; abort on mismatch.
4. Extract to `~/.mma/versions/<version>`; flip `~/.mma/current` to it.
5. Ensure `~/.mma/bin` on PATH (Windows: user PATH via registry/`setx`; unix: append to the
   detected shell rc). Best-effort with a printed instruction if it cannot modify PATH.
6. Verify `~/.mma/current/bin/mma --version`; print next steps (new terminal → `mma setup` →
   `mma`).

Rules:

- **Never read stdin** (piped scripts) — all decisions from OS/env detection.
- **Idempotent** — re-running downloads and installs the latest; the previous version directory is
  kept for rollback.
- **Dry-run** — `MMA_INSTALL_DRY_RUN=1` prints the resolved URLs/paths/commands without network or
  writes, for CI smoke tests.

### 6. Updater rework (no npm)

`Updater.check()` stops querying `registry.npmjs.org` and instead fetches `<base>/latest.json`,
comparing `version` with the running version (`semverGt` stays). `Updater.install()` replaces the
`npm install -g` command with a pure download/extract: fetch the platform artifact, verify
`sha256`, extract to `~/.mma/versions/<version>`, flip `current`. This removes the `InstallRunner`
shell-out path (`checker.ts:123-131`) and the Windows `.cmd` wrapping.

- Fail-open as today (offline/parse/IO errors → no update, logged).
- The dev-entry guard (`isDevEntryPath`) stays: a checkout never overwrites a real install.
- `autoInstall` semantics unchanged; the `updater.available` message now points at the one-liner.

### 7. Playwright

`playwright` stays a production dependency bundled in the tarball. Chromium is downloaded on first
browser-tool use by the existing environment check / install hint (`environment.ts:210`). The
bundled Bun can run `playwright install chromium` without npm.

### 8. npm removal (after the first working GitHub release)

Separate, explicit step once a release is verified:

- `npm deprecate micro-models-agent "Moved to GitHub Releases — see <repo>"`.
- `npm unpublish` versions still within the 72-hour window; older versions remain but are marked
  deprecated and can no longer be unpublished.
- `package.json` keeps only build metadata (`name`, `version`, scripts, deps); the `publishConfig`
  / npm distribution role is dropped from docs.

### 9. Docs, i18n, release

- `README.md`: replace the npm install section with the one-liners and a short "what the script
  does"; link `docs/install.md`.
- New `docs/install.md`: requirements, one-liners, layout of `~/.mma`, update, rollback
  (`current` symlink), uninstall (delete `~/.mma`), troubleshooting (offline, PATH, checksum,
  Gatekeeper/SmartScreen), env vars.
- `docs/agents/*` + `AGENTS.md`: "Distribution & Bootstrap" section (scripts, `MMA_INSTALL_BASE`,
  manifest, updater).
- `LICENSE` (MIT), `CONTRIBUTING.md` (optional).
- i18n en+ru: `updater.available` reworded to the one-liner; new install-related strings for the
  scripts' child messages.
- `CHANGELOG.md`: MINOR entry (new distribution surface). The npm removal step, when done, is its
  own changelog entry and may be classified MAJOR if it breaks existing npm-based auto-update for
  published users.

## Alternatives rejected

- **Compiled single binary + bootstrap.** Smallest artifact, but requires embedding every web
  asset and reworking Playwright's browser download; can supersede this later without changing the
  one-liner entry point.
- **Public artifact host (R2/S3) instead of GitHub Releases.** Unnecessary now that the repo is
  public; GitHub Releases already gives anonymous stable URLs, CI, and checksums.
- **Install Bun via the official installer, then `bun add -g`.** Still depends on the npm registry
  (Bun resolves packages from it) and does not support pinned/offline installs; the user wants npm
  gone entirely.
- **Keep npm as a parallel channel.** Contradicts the goal; deprecated then removed.

## Open items

- **Code signing** (macOS notarization, Windows Authenticode) — deferred; unsigned installs warn.
- **`linux-arm64` runner availability** for public repos — if `ubuntu-24.04-arm` is unavailable,
  build it via cross-compilation or a self-hosted runner.
- **`scripts/install.*` default base** assumes the repo path `Alexeykoh/micro-model-agent` and
  branch `master`; overridable via `MMA_INSTALL_BASE`.

## Tests

- **Updater** (`tests/updater-module.test.ts` etc.): `check()` parses `latest.json` and compares
  versions; `install()` downloads to a temp dir, verifies `sha256`, extracts, flips `current`; bad
  checksum / offline → fail-open; dev-entry guard still blocks self-update from a checkout.
- **Manifest**: a guard test that `latest.json` shape matches what `Updater` and both scripts
  read (same keys), preventing drift.
- **Scripts**: `MMA_INSTALL_DRY_RUN=1` smoke per platform asserts the resolved manifest URL,
  artifact name, checksum and target paths without network.
- **Release workflow**: a dry-run/validation job that builds the artifact locally and checks its
  layout (`runtime/`, `app/main.js`, `app/assets`, `VERSION`) before publishing.
- Manual end-to-end on a clean VM per OS before the first release (real download → `mma setup`).
- `bun run quality` green.
