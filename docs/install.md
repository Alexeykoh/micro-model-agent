# Installing MMA

MMA ships as a **self-contained release**: a bundled Bun runtime, the agent
bundle, production dependencies and web assets. No Node.js, npm or Bun needs to
be installed first. Releases are published to GitHub Releases.

## Install

**Windows** (PowerShell 5.1+):

```powershell
irm https://raw.githubusercontent.com/Alexeykoh/micro-model-agent/master/scripts/install.ps1 | iex
```

**macOS / Linux**:

```bash
curl -fsSL https://raw.githubusercontent.com/Alexeykoh/micro-model-agent/master/scripts/install.sh | bash
```

Then open a new terminal and run:

```bash
mma setup     # provider / model / context wizard
mma           # interactive REPL
```

## What the installer does

1. Detects your OS and architecture (`win-x64`, `mac-arm64`, `mac-x64`,
   `linux-x64`, `linux-arm64`).
2. Downloads `latest.json` from the release and picks the matching artifact.
3. Downloads `mma-<os>-<arch>.tar.gz` and verifies its `sha256`.
4. Extracts it to `~/.mma/versions/<version>` and flips `~/.mma/current` to it.
5. Adds `~/.mma/bin` to `PATH` and writes the launcher.
6. Runs `mma --version` to verify.

## Layout

```
~/.mma/
  versions/<version>/     # extracted release: runtime/, app/, package.json, VERSION
  current -> versions/<version>
  bin/mma(.cmd)           # launcher (on PATH)
```

## Update

Re-run the same one-liner. The installer is idempotent: it downloads the latest
release and switches `current`. The previous version stays under `versions/`
for rollback.

The in-app updater (`updater.enabled`) also checks GitHub Releases for a newer
version and, with `updater.autoInstall: true`, downloads and activates it in the
background. The running process keeps using the old version until restarted.

## Rollback

Point `current` at a previous version directory:

```bash
# macOS / Linux
ln -sfn versions/<old-version> ~/.mma/current
```

```powershell
# Windows
Remove-Item "$env:USERPROFILE\.mma\current" -Recurse -Force
New-Item -ItemType Junction -Path "$env:USERPROFILE\.mma\current" -Target "$env:USERPROFILE\.mma\versions\<old-version>"
```

## Uninstall

```bash
# macOS / Linux
rm -rf ~/.mma
```

```powershell
# Windows
Remove-Item "$env:USERPROFILE\.mma" -Recurse -Force
# and remove %USERPROFILE%\.mma\bin from PATH
```

## Browser tool

The `playwright` package ships with the release, but Chromium is downloaded on
first use. If the browser tool reports a missing browser:

```bash
~/.mma/current/runtime/bun x playwright install chromium
```

## Environment variables

| Variable               | Meaning                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `MMA_INSTALL_BASE`     | Override the release base URL (mirror / pinned release).     |
| `MMA_HOME`             | Install root (default `~/.mma`).                             |
| `MMA_INSTALL_DRY_RUN=1`| Print the installer plan without network or writes.          |
| `MMA_CONFIG_DIR`       | Override the agent data directory (config, sessions, memory).|

## Troubleshooting

- **`mma` not found after install** — open a new terminal so `PATH` refreshes.
  On Windows the installer updates the *user* `PATH`.
- **Checksum mismatch** — the download was truncated or a mirror is stale.
  Retry; if it persists, check `MMA_INSTALL_BASE`.
- **macOS Gatekeeper / Windows SmartScreen warning** — release binaries are not
  code-signed yet. Allow the download, or build the release yourself
  (`bun run build:release`).
- **Offline install** — set `MMA_INSTALL_BASE` to a mirror that serves
  `latest.json`, `mma-<os>-<arch>.tar.gz` and the install scripts.
