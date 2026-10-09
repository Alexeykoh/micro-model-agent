# Bootstrap Installer — design

Date: 2026-10-09
Status: proposed (branch `feat/bootstrap-installer`)

## Problem

MMA is distributed only as an npm package (`micro-models-agent`). Installing it requires a
package manager (`npm`) and, for full features, a Bun runtime: `bin/mma.mjs:24-36` re-executes
itself under Bun when Bun is on `PATH`, and degrades (no clipboard image paste, Windows LSP via
`npx.cmd`, on-the-fly TS transpile) when only Node is present. The target user for this task has
**nothing but an operating system** — no Node, no npm, no Bun. There is currently no way for that
user to install and run `mma`.

This is a distribution gap, not a runtime gap: the harness itself works under Bun on all three
platforms. What is missing is a bootstrap that acquires the runtime and the package for the user.

## Goals

- A user with a stock Windows / macOS / Linux machine can install `mma` with a single shell
  one-liner, no pre-installed runtime.
- Full Bun-backed feature set after install (clipboard paste, LSP, frontend transpile).
- Re-running the bootstrap updates to the latest published version (idempotent).
- The in-app updater keeps working for a Bun-only install (no `npm` on the machine).
- Nothing in the existing `dist`-contract, asset loading, or `bin/mma.mjs` respawn logic changes.

## Non-goals

- **No compiled single-file binary.** `bun build --compile` would require refactoring the
  web-asset loader (`src/modules/webui/assets.ts:16-23` reads `index.html` / `css` / `js/**`
  from disk relative to `dist/`) to embedded `import ... with { type: "text" }` imports, plus
  separate handling for Playwright. Deferred (see Alternatives).
- **No OS-native installer** (`.msi` / `.pkg` / `.deb`), no code signing, no menu shortcuts,
  no managed uninstaller. The global package is removed with the runtime's own
  `bun remove -g micro-models-agent`.
- **No offline / pinned-version bundle.** The bootstrap fetches the runtime and package from the
  network each run. A self-contained per-OS release tarball (runtimes + `node_modules`) is the
  documented successor (see Alternatives) if offline installs are later required.
- **No Playwright bundling.** `playwright` stays a normal dependency; Chromium is downloaded on
  first browser-tool use via the existing path (`src/core/environment.ts:210` warns and points
  at `bunx playwright install chromium`).

## Design

### 1. Bootstrap scripts

Two scripts, committed to the repository and served over HTTP(S):

- `scripts/install.sh` — macOS / Linux
- `scripts/install.ps1` — Windows (PowerShell 5.1+)

Canonical one-liners:

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/<owner>/<repo>/<branch>/scripts/install.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/<branch>/scripts/install.sh | bash
```

`<owner>/<repo>/<branch>` is the eventual public GitHub location (`microModelsAgent`, default
branch `master`); until the GitHub migration lands the raw base points at the current Gitea raw
URL for internal testing. The base is overridable by either script via the `MMA_INSTALL_BASE`
environment variable so a mirror can be used without editing the scripts.

Hard rules for both scripts:

- **Never read stdin.** They are piped (`curl | bash`, `irm | iex`), so any prompt would consume
  the script body. All decisions are made from environment/OS detection; failures exit non-zero
  with a message.
- **Idempotent.** `bun` is installed only if absent; the package is always (re)installed at
  `@latest`, which is also the update path.
- **Dry-run hook.** `MMA_INSTALL_DRY_RUN=1` prints the commands it would run without executing
  them, so the scripts can be smoke-tested on CI without network or side effects.
- **Non-destructive to an existing npm install.** If `mma` is already on `PATH` from a different
  manager, the script prints a warning and continues (the user chose to run it).

### 2. `install.sh` (macOS / Linux)

1. Detect OS (`uname -s` → `Darwin`/`Linux`) and arch (`uname -m` → `x86_64`/`arm64`; `aarch64`
   normalized to `arm64`). Unsupported → clear error, exit 1.
2. Ensure Bun:
   - native path `~/.bun/bin/bun`; if missing, run the official installer:
     `curl -fsSL https://bun.sh/install | bash` (installs to `~/.bun`, appends
     `BUN_INSTALL`/`PATH` to the user's shell rc).
   - installer failure (network/offline) → error naming the cause, exit 1.
3. Install/update the package:
   `~/.bun/bin/bun add -g micro-models-agent@latest`. Absolute `bun` path is used because the
   current shell's `PATH` was not reloaded after step 2.
4. Verify: `~/.bun/bin/mma --version`.
5. Print next steps: open a new terminal, run `mma setup`, then `mma`.

### 3. `install.ps1` (Windows)

1. Detect arch (`$env:PROCESSOR_ARCHITECTURE`: `AMD64`/`ARM64`). Unsupported → error, exit 1.
2. Ensure Bun: `$bun = "$env:USERPROFILE\.bun\bin\bun.exe"`; if missing run
   `irm https://bun.sh/install.ps1 | iex` (installs under `%USERPROFILE%\.bun`, updates the user
   `PATH`). Failure → error, exit 1.
3. `& $bun add -g micro-models-agent@latest`.
4. Verify `& "$env:USERPROFILE\.bun\bin\mma.exe" --version` (Bun emits an `mma.exe` / `mma.cmd`
   shim on Windows; the exact name is checked in the script).
5. Print next steps (`mma setup`, then `mma`).

The scripts themselves call no `bash`/`sh` helper; each is self-contained so it can be hosted and
piped individually.

### 4. Runtime-agnostic updater (the only core change)

`Updater.buildInstallCommand` (`src/modules/updater/checker.ts:123-131`) hardcodes `npm install -g`.
For a Bun-only machine there is no `npm`, so auto-install would fail. Make the command depend on
what is actually on `PATH`:

- `npm` resolvable → `npm install -g <pkg>@<version>` (unchanged; existing npm installs keep
  working).
- `npm` absent, `bun` resolvable → `bun add -g <pkg>@<version>`.
- neither → `install()` returns `{ success: false, error }` as today.

Availability is checked with the existing PATH resolver (`findOnPath`, `src/modules/lsp/resolve.ts`)
rather than by spawning and parsing an error, so the choice is deterministic. The Windows
`.cmd`/`.bat` wrapper (`cmd.exe /c`, `checker.ts:126-129`) is kept and applies to `bun.cmd` too.

The `updater.available` notice currently tells the user to run `npm install -g …`
(`i18n/{en,ru}.json`, `updater.available`). Because a Bun-only user has no `npm`, the command in
the message must reflect the resolved manager. The hint becomes manager-aware (new i18n key for
the Bun spelling; the npm spelling is unchanged).

### 5. What is intentionally untouched

- `bin/mma.mjs` — after a Bun install the generated shim already runs under Bun, so the respawn
  at `bin/mma.mjs:24-36` is a no-op. No change.
- Web asset loading, `dist` layout, `build:prod`, the `--packages external` bundle. No change.
- `session_*` / plugin / service contracts. No change.

### 6. Docs, i18n, release

- `README.md` Installation: add an "Install without a runtime" section with the two one-liners,
  above the npm section; mention removal via `bun remove -g micro-models-agent`.
- New `docs/install.md`: requirements, one-liners, what the script does, update (`re-run`),
  uninstall, troubleshooting (offline, PATH not refreshed, existing npm install).
- `docs/agents/*` and `AGENTS.md`: a short "Bootstrap Installer" section documenting the scripts,
  the `MMA_INSTALL_BASE` / `MMA_INSTALL_DRY_RUN` env vars, and the updater manager selection.
- `CHANGELOG.md` entry; **MINOR** bump (new install surface + updater behavior).
- `updater.available` i18n stays in en+ru for the new manager-aware command.

## Alternatives rejected

- **Compiled single binary (`bun build --compile`) + bootstrap that downloads it.** Smallest
  artifact, but requires embedding every web asset (fs-read → embedded imports), reworking
  Playwright's separate browser download, cross-compiling and signing for three targets. Larger
  and riskier than this task warrants; can supersede this design later without discarding the
  bootstrap entry point.
- **Self-contained release tarball (Bun runtime + `dist/` + prod `node_modules` + assets) per OS,
  hosted on GitHub Releases.** Pinned versions and offline installs after first download, but
  means a CI matrix, artifact hosting, and reworking the updater to fetch tarballs. This is the
  documented successor if offline/version-pinning becomes a requirement.
- **Skip the runtime and use Node via the OS package manager** (`apt install nodejs`, winget,
  Homebrew). Reintroduces a per-OS prerequisite, requires admin, and loses the Bun-backed
  features — the exact problem being solved.
- **Have the bootstrap install Bun but leave `updater` on `npm install -g`.** Breaks auto-update
  for exactly the users this task adds; rejected.

## Open items

- **Hosting:** final `<owner>/<repo>/<branch>` for the default `MMA_INSTALL_BASE` is fixed when the
  repository moves to public GitHub (separate migration task, including moving
  `.gitea/workflows/quality.yml` to `.github/workflows/`). Until then the default points at the
  current Gitea raw URL. The scripts are host-agnostic by construction (env override).

## Tests

- **Unit — updater manager selection** (`tests/updater-module.test.ts`, add cases):
  - npm present → `npm install -g <pkg>@<ver>`.
  - npm absent, bun present → `bun add -g <pkg>@<ver>`.
  - neither → `install()` returns `success: false`.
  - Windows `.cmd` wrapping still applied to the resolved command.
  - Injected `InstallRunner` keeps the existing tests hermetic.
- **Scripts — dry-run smoke** (`MMA_INSTALL_DRY_RUN=1`): assert the printed command sequence per
  platform (OS/arch detection, Bun install, `bun install -g ...@latest`, verify, next steps)
  without network. One test per script via a thin invocation wrapper.
- **Docs/guard:** a guard test that the README one-liners and `docs/install.md` reference the same
  `MMA_INSTALL_BASE` env var and manager command as the updater (prevents drift between docs and
  behavior).
- Manual end-to-end on a clean VM per OS before release (real Bun install + `mma setup`).
- `bun run quality` (typecheck + frontend + lint + fallow) green.
