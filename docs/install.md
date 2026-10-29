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

## Manual install (no script)

Use this when the one-liner is blocked — a corporate proxy with TLS interception,
no shell access, or an air-gapped machine — or when you want the files in your own
directory. The artifacts are the same `mma-<os>-<arch>.tar.gz` files from GitHub
Releases, and they already contain the Bun runtime: nothing else is required.

### 1. Download the artifact

Open <https://github.com/Alexeykoh/micro-model-agent/releases/latest> and take the
file for your system:

| System              | Artifact                 |
| ------------------- | ------------------------ |
| Windows x64         | `mma-win-x64.tar.gz`     |
| Windows ARM64       | `mma-win-arm64.tar.gz`   |
| macOS Apple Silicon | `mma-mac-arm64.tar.gz`   |
| macOS Intel         | `mma-mac-x64.tar.gz`     |
| Linux x64           | `mma-linux-x64.tar.gz`   |
| Linux ARM64         | `mma-linux-arm64.tar.gz` |

> Windows ARM64 builds only exist once the release workflow publishes that
> platform; if the file is missing, use the x64 build under emulation.

### 2. Verify the checksum (recommended)

`latest.json` in the same release lists `sha256` and `size` per artifact.

```bash
# macOS / Linux
shasum -a 256 mma-mac-arm64.tar.gz     # or: sha256sum
```

```powershell
# Windows
Get-FileHash -Algorithm SHA256 "$env:USERPROFILE\Downloads\mma-win-x64.tar.gz"
```

Compare with `artifacts["<platform>"].sha256` from `latest.json`. A mismatch
means a truncated download or a stale mirror: download again.

### 3. Extract and run

**Windows (PowerShell, no admin rights needed).** `tar` ships with Windows 10+.

```powershell
$dst = "$env:USERPROFILE\mma"
New-Item -ItemType Directory -Force $dst | Out-Null
tar -xzf "$env:USERPROFILE\Downloads\mma-win-x64.tar.gz" -C $dst
& "$dst\runtime\bun.exe" "$dst\app\main.js" --version
```

**macOS (arm64 or x64).**

```bash
mkdir -p ~/mma
tar -xzf ~/Downloads/mma-mac-arm64.tar.gz -C ~/mma
~/mma/runtime/bun ~/mma/app/main.js --version
```

**Linux (x64 or arm64).**

```bash
mkdir -p ~/mma
tar -xzf ~/Downloads/mma-linux-x64.tar.gz -C ~/mma
chmod +x ~/mma/runtime/bun
~/mma/runtime/bun ~/mma/app/main.js --version
```

### 4. Put `mma` on `PATH` (optional)

```powershell
# Windows
$bin = "$env:USERPROFILE\.local\bin"
New-Item -ItemType Directory -Force $bin | Out-Null
Set-Content "$bin\mma.cmd" -Encoding ASCII -Value "@echo off`r`n`"$env:USERPROFILE\mma\runtime\bun.exe`" `"$env:USERPROFILE\mma\app\main.js`" %*"
# then add $bin to the user PATH once and open a new terminal
```

```bash
# macOS / Linux
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec "%s/mma/runtime/bun" "%s/mma/app/main.js" "$@"\n' "$HOME" "$HOME" > ~/.local/bin/mma
chmod +x ~/.local/bin/mma
# then: export PATH="$HOME/.local/bin:$PATH" (and add it to ~/.zshrc or ~/.bashrc)
```

### Updates and caveats

- A manual install is **not** managed by the in-app updater: it reads and
  activates versions under `~/.mma`. To update, download the new tarball and
  replace your directory (or switch to the installer later).
- macOS Gatekeeper may block an unsigned binary: allow it in
  *System Settings → Privacy & Security*, or run
  `xattr -dr com.apple.quarantine ~/mma/runtime/bun`.
- Windows SmartScreen may warn on the first run — release binaries are not
  code-signed yet.
- Config, sessions and memory still live in `~/.mma` (override with
  `MMA_CONFIG_DIR`); only the program files live in the directory you chose.

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
