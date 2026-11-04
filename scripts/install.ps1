# MMA bootstrap installer - Windows (PowerShell 5.1+).
#
# Downloads a self-contained release (bundled Bun runtime + app + prod deps)
# from GitHub Releases into $env:USERPROFILE\.mma and adds an `mma` launcher
# to PATH.
#
#   irm https://raw.githubusercontent.com/Alexeykoh/micro-model-agent/master/scripts/install.ps1 | iex
#
# This file is deliberately ASCII-only: Windows PowerShell 5.1 reads scripts
# without a BOM as ANSI, so a stray non-ASCII byte breaks parsing after
# `irm | iex`. tests/install-retry.test.ts guards that invariant.
#
# Env:
#   MMA_INSTALL_BASE    mirror / release base (default: GitHub Releases)
#   MMA_HOME            install root (default: %USERPROFILE%\.mma)
#   MMA_INSTALL_DRY_RUN=1  print the plan without network or writes
#   MMA_INSTALL_NO_PATH=1  do not change the user PATH (CI/tests/corporate)
#   MMA_NPM_PREFIX      override `npm prefix -g` for legacy-shim detection
$ErrorActionPreference = "Stop"
# PS 5.1 redraws a progress bar per block: that alone makes an 80 MB download slow.
$ProgressPreference = "SilentlyContinue"
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }

$MmaRepo = "Alexeykoh/micro-model-agent"
$Base = if ($env:MMA_INSTALL_BASE) { $env:MMA_INSTALL_BASE.TrimEnd('/') } else { "https://github.com/$MmaRepo/releases/latest/download" }
$MmaHome = if ($env:MMA_HOME) { $env:MMA_HOME } else { Join-Path $env:USERPROFILE ".mma" }
$binDir = Join-Path $MmaHome "bin"
$launcher = Join-Path $binDir "mma.cmd"
$Dry = $env:MMA_INSTALL_DRY_RUN -eq "1"
$NoPath = $env:MMA_INSTALL_NO_PATH -eq "1"
# A flaky or slow link must not require a manual re-run of the installer.
$Attempts = 3

# --- look & feel ----------------------------------------------------------
# Colours and animation are strictly best-effort: redirected output (CI, pipes,
# WinForms hosts) stays plain so logs and tests never contain escape codes.
$Esc = [char]27
$Interactive = -not [Console]::IsOutputRedirected -and -not $env:CI
$Vt = $Interactive -and ($Host.UI.SupportsVirtualTerminal -or $env:WT_SESSION -or $env:TERM)
function Color([string]$sgr) {
  if ($Vt) { return "$Esc[$sgr" }
  return ""
}
$Accent = Color "38;5;183m"
$OkColor = Color "38;5;150m"
$Dim = Color "38;5;245m"
$ErrColor = Color "38;5;203m"
$Bold = Color "1m"
$Reset = Color "0m"
$Faces = @{
  idle = " []      []  "
  blink = " --      --  "
  happy = " ^       ^   "
  sad = " x       x   "
}

function Show-Mascot([string]$face) {
  $eyes = $Faces[$face]
  if (-not $eyes) { $eyes = $Faces["idle"] }
  Write-Host ""
  Write-Host "  $Accent+-------------+$Reset  $Bold MMA installer$Reset"
  Write-Host "  $Accent|$eyes|$Reset  $Dim GitHub Releases - $key$Reset"
  Write-Host "  $Accent+-------------+$Reset  $Dim home: $MmaHome$Reset"
  Write-Host ""
}

function Say([string]$m) { Write-Host "mma: $m" }
function Die([string]$m) {
  if ($Interactive) { Show-Mascot "sad" }
  Write-Error "mma: $m"
  exit 1
}

# True when $path is $dir itself or lives under it (case-insensitive on Windows).
function Test-Under([string]$path, [string]$dir) {
  if (-not $path -or -not $dir) { return $false }
  $p = $path.Replace('/', '\').TrimEnd('\')
  $d = $dir.Replace('/', '\').TrimEnd('\')
  return ($p -ieq $d) -or $p.StartsWith("$d\", [StringComparison]::OrdinalIgnoreCase)
}

# PATH scan instead of Get-Command: Get-Command caches discovery, so it would
# report the pre-install resolution right after PATH is updated.
function Find-MmaOnPath([string]$pathValue) {
  foreach ($dir in ($pathValue -split ';')) {
    if (-not $dir) { continue }
    foreach ($name in @("mma.exe", "mma.cmd", "mma.bat", "mma.ps1")) {
      $candidate = Join-Path $dir $name
      if (Test-Path $candidate -PathType Leaf) { return $candidate }
    }
  }
  return $null
}

# npm prefix for legacy detection: explicit override first, then `npm prefix -g`.
# A missing npm is not an error: then we simply cannot classify the shim as npm.
function Get-NpmPrefix() {
  if ($env:MMA_NPM_PREFIX) { return $env:MMA_NPM_PREFIX.TrimEnd('\', '/') }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { return $null }
  try {
    $prefix = & npm prefix -g 2>$null | Select-Object -First 1
    if ($prefix) { return ([string]$prefix).Trim().TrimEnd('\', '/') }
  } catch { }
  return $null
}

# Retire (rename, never delete) the npm launchers that shadow `mma`. Reversible:
# the backup name is printed. This is the only reliable way to win when the npm
# prefix sits in the MACHINE PATH, where user-PATH order cannot help.
function Retire-LegacyNpmShims([string]$prefix) {
  $moved = @()
  foreach ($name in @("mma.cmd", "mma.ps1", "mma")) {
    $path = Join-Path $prefix $name
    if (-not (Test-Path $path -PathType Leaf)) { continue }
    $backup = "$path.legacy-npm.bak"
    try {
      if (Test-Path $backup) { Remove-Item $backup -Force }
      Move-Item $path $backup -ErrorAction Stop
      $moved += $path
      Say "retired legacy npm launcher: $path (backup: $backup)"
    } catch {
      Say "warning: cannot move $path ($($_.Exception.Message)); remove it with: npm rm -g micro-models-agent"
    }
  }
  if ($moved.Count -gt 0) {
    Say "after the new mma works, clean up npm: npm rm -g micro-models-agent"
  }
  return $moved
}

# --- detect platform -------------------------------------------------------
$pa = $env:PROCESSOR_ARCHITECTURE
if ($pa -eq "x86" -and $env:PROCESSOR_ARCHITEW6432) { $pa = $env:PROCESSOR_ARCHITEW6432 }
$arch = switch ($pa) {
  "AMD64" { "x64" }
  "ARM64" { "arm64" }
  default { $null }
}
if (-not $arch) { Die "unsupported architecture: $pa" }
$key = "win-$arch"
$artifact = "mma-$key.tar.gz"

Show-Mascot "idle"

# --- legacy preflight ------------------------------------------------------
# Detect a shadowing `mma` BEFORE install: the new launcher does not exist yet,
# so any hit outside $binDir is a legacy copy. Classification as npm needs the
# npm prefix; without npm we still warn but never touch the file.
$legacyMma = Find-MmaOnPath $env:Path
$npmPrefix = $null
$legacyIsNpm = $false
if ($legacyMma -and -not (Test-Under $legacyMma $binDir)) {
  $npmPrefix = Get-NpmPrefix
  $legacyIsNpm = Test-Under $legacyMma $npmPrefix
}

if ($Dry) {
  Say "dry-run: platform=$key"
  Say "dry-run: manifest=$Base/latest.json"
  Say "dry-run: artifact=$Base/$artifact"
  Say "dry-run: install=$MmaHome\versions\<version> ; current=$MmaHome\current ; bin=$launcher"
  if ($legacyMma) { Say "dry-run: legacy=$legacyMma" } else { Say "dry-run: legacy=none" }
  if ($legacyIsNpm) { Say "dry-run: npm-prefix=$npmPrefix" }
  if ($NoPath) {
    Say "dry-run: path=unchanged (MMA_INSTALL_NO_PATH=1); add manually: $binDir"
  } else {
    Say "dry-run: path=prepend $binDir to the user PATH"
  }
  exit 0
}

if ($legacyIsNpm) {
  Say "found legacy npm install: $legacyMma"
} elseif ($legacyMma) {
  Say "another mma is on PATH: $legacyMma"
}

# --- transport -------------------------------------------------------------
# The manifest fetch is retried too: a one-second network hiccup should not
# turn into "run the installer again".
function Get-Manifest([string]$uri) {
  for ($i = 1; $i -le $Attempts; $i++) {
    try {
      return Invoke-RestMethod -Uri $uri -UseBasicParsing
    } catch {
      if ($i -eq $Attempts) { Die "cannot fetch $uri ($($_.Exception.Message))" }
      Say "manifest fetch failed, retrying ($i/$Attempts)"
      Start-Sleep -Seconds $i
    }
  }
}

function Get-Sha256([string]$path) {
  # .NET API instead of Get-FileHash: cmdlet autoload depends on PSModulePath,
  # which may be inherited from another PowerShell major version.
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($path)
    try {
      $hex = [System.BitConverter]::ToString($sha.ComputeHash($stream))
      return $hex.Replace("-", "").ToLower()
    } finally { $stream.Dispose() }
  } finally { $sha.Dispose() }
}

# Download with resume. An interrupted transfer continues where it stopped
# (including across installer runs: the partial file lives in a stable cache
# directory); a corrupt one (sha256 mismatch) is discarded and fetched again
# from scratch, otherwise resuming would glue garbage to a broken prefix.
function Get-Artifact([string]$uri, [string]$out, [long]$size, [string]$sha) {
  $mb = 1MB
  for ($i = 1; $i -le $Attempts; $i++) {
    if ($i -gt 1) { Start-Sleep -Seconds (2 * ($i - 1)) }

    $have = 0
    if (Test-Path $out) { $have = (Get-Item $out).Length }
    if ($have -gt $size) {
      # Longer than expected: not a prefix, resume is meaningless.
      Remove-Item $out -Force
      $have = 0
    }

    if ($have -lt $size) {
      if ($have -gt 0) {
        Say ("resuming download at {0:N1} of {1:N1} MB" -f ($have / $mb), ($size / $mb))
      }
      try {
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
          # `--progress-bar` when a human watches; `-sS` keeps CI/test logs
          # clean while still surfacing real errors. --speed-limit aborts a
          # stalled transfer so the retry loop resumes instead of hanging.
          $bar = if ($Interactive) { "--progress-bar" } else { "-sS" }
          $curlArgs = @(
            "-fL", $bar, "--connect-timeout", "30",
            "--speed-limit", "2048", "--speed-time", "60", "-o", $out
          )
          if ($have -gt 0) { $curlArgs += @("-C", "-") }
          $curlArgs += $uri
          & curl.exe @curlArgs
          if ($LASTEXITCODE -ne 0) { throw "curl exited with code $LASTEXITCODE" }
        } else {
          # Windows PowerShell cannot resume with Invoke-WebRequest: start over.
          if (Test-Path $out) { Remove-Item $out -Force }
          Say "downloading (no progress available) ..."
          Invoke-WebRequest -Uri $uri -OutFile $out -UseBasicParsing
        }
      } catch {
        Say "download attempt $i failed: $($_.Exception.Message)"
        continue
      }
    }

    $now = 0
    if (Test-Path $out) { $now = (Get-Item $out).Length }
    if ($now -ne $size) {
      Say ("download incomplete ({0:N1} of {1:N1} MB), retrying" -f ($now / $mb), ($size / $mb))
      continue
    }
    if ((Get-Sha256 $out) -ne $sha.ToLower()) {
      Say "checksum mismatch: discarding the download and retrying"
      Remove-Item $out -Force
      continue
    }
    return
  }
  Die "could not download $uri in $Attempts attempts; rerun the installer to resume, or check your connection"
}

# cmd's rmdir removes a junction/symlink without following it: Remove-Item
# -Recurse in PowerShell 5.1 walks into the link and deletes the target.
function Remove-Link([string]$path) {
  if (-not (Test-Path $path)) { return $true }
  & cmd /c rmdir "$path" 2>$null | Out-Null
  return -not (Test-Path $path)
}

# --- install ---------------------------------------------------------------
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("mma-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Say "fetching manifest ..."
  $manifest = Get-Manifest "$Base/latest.json"
  $entry = $manifest.artifacts.PSObject.Properties[$key].Value
  if (-not $entry) { Die "platform $key not found in manifest" }

  # The manifest artifact name becomes the URL tail: relative names only.
  $name = [string]$entry.url
  $unsafeName = (-not $name) -or ($name -match '^[a-z][a-z0-9+.-]*:') -or $name.StartsWith("/") -or `
    $name.StartsWith("\") -or (($name -split '[\\/]') -contains "..")
  if ($unsafeName) { Die "unsafe artifact url in manifest: $name" }

  $sha = [string]$entry.sha256
  if ($sha -notmatch '^[0-9a-fA-F]{64}$') { Die "manifest has no valid checksum (sha256) for $key" }
  $size = 0L
  if ($entry.size) { $size = [long]$entry.size }
  if ($size -le 0) { Die "manifest has no artifact size for $key" }

  # The tarball lives in a stable cache directory, not in the per-run temp dir:
  # after Ctrl+C a rerun continues the download instead of starting 78 MB over.
  $downloadDir = if ($env:MMA_DOWNLOAD_DIR) { $env:MMA_DOWNLOAD_DIR } else { Join-Path ([System.IO.Path]::GetTempPath()) "mma-download" }
  New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
  $tar = Join-Path $downloadDir $artifact
  $sizeMb = [math]::Round($size / 1MB, 1)
  Say ("downloading $artifact ({0} MB) ..." -f $sizeMb)
  Say "interrupting is safe: rerun the same command and the download resumes"
  Get-Artifact "$Base/$name" $tar $size $sha

  $pkg = Join-Path $tmp "pkg"
  New-Item -ItemType Directory -Path $pkg | Out-Null
  # Pass the archive by basename from its directory: GNU tar (Git for Windows in
  # PATH) reads an absolute "C:\..." as host:path and fails with "Cannot connect to C:".
  Push-Location $downloadDir
  try {
    & tar -xzf $artifact -C $pkg
  } finally {
    Pop-Location
  }
  if ($LASTEXITCODE -ne 0) { Die "extraction failed" }

  $versionFile = Join-Path $pkg "VERSION"
  if (-not (Test-Path $versionFile)) { Die "invalid archive: VERSION missing" }
  $version = (Get-Content $versionFile -Raw).Trim()
  if ($version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') {
    Die "invalid archive: unsafe VERSION '$version'"
  }

  $versions = Join-Path $MmaHome "versions"
  New-Item -ItemType Directory -Force -Path $versions, $binDir | Out-Null
  $target = Join-Path $versions $version
  $staging = Join-Path $versions "$version.tmp"

  # Stage next to the target: rename is atomic and never leaves a half-unpacked
  # version behind.
  if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
  Move-Item $pkg $staging
  # Replace by rename, never by in-place delete: deleting the directory of a
  # running MMA wipes its files one by one and only then fails on the locked
  # directory. A failed rename leaves the live version untouched.
  $previous = Join-Path $versions ("$version.old-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))
  if (Test-Path $target) {
    try {
      Move-Item $target $previous -ErrorAction Stop
    } catch {
      Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
      Die "version $version is in use; close MMA, then run the installer again"
    }
  }
  Move-Item $staging $target
  if (Test-Path $previous) {
    # Best effort: a still-locked directory is swept on the next MMA start.
    try {
      Remove-Item $previous -Recurse -Force -ErrorAction Stop
    } catch {
      Say "note: $previous will be removed on the next MMA start"
    }
  }

  $current = Join-Path $MmaHome "current"
  $stagedLink = Join-Path $MmaHome ".current.new"
  if (-not (Remove-Link $stagedLink)) { Die "cannot remove stale $stagedLink" }
  New-Item -ItemType Junction -Path $stagedLink -Target $target | Out-Null
  if (-not (Remove-Link $current)) {
    Die "cannot replace $current; remove it manually and run the installer again"
  }
  Move-Item $stagedLink $current

  $launcher = Join-Path $binDir "mma.cmd"
  $content = "@echo off`r`n`"$MmaHome\current\runtime\bun.exe`" `"$MmaHome\current\app\main.js`" %*`r`n"
  Set-Content -Path $launcher -Value $content -Encoding ASCII

  # The new launcher exists now, so the old npm one is redundant. Retire it even
  # when PATH order looks fine: the npm prefix may live in the MACHINE PATH,
  # which every user-PATH change loses to.
  if ($legacyIsNpm) { Retire-LegacyNpmShims $npmPrefix | Out-Null }

  # --- PATH: bin must be FIRST, not appended -------------------------------
  if ($NoPath) {
    Say "PATH not changed (MMA_INSTALL_NO_PATH=1); add manually: $binDir"
  } else {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @()
    if ($userPath) { $entries = @($userPath.Split(';') | Where-Object { $_ -ne "" }) }
    $first = $entries[0]
    $alreadyFirst = $first -and ($first.TrimEnd('\') -ieq $binDir.TrimEnd('\'))
    if (-not $alreadyFirst) {
      $kept = @($entries | Where-Object { -not ($_.TrimEnd('\') -ieq $binDir.TrimEnd('\')) })
      $newPath = (@($binDir) + $kept) -join ';'
      [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
      Say "put $binDir first on the user PATH (restart your terminal)"
    }
  }
  # Session PATH counts for the verification below (and for a re-run in the
  # same window); it never touches the registry when MMA_INSTALL_NO_PATH=1.
  $env:Path = "$binDir;$env:Path"

  # --- verify --------------------------------------------------------------
  $bun = Join-Path $current "runtime\bun.exe"
  $mainJs = Join-Path $current "app\main.js"
  $resolved = Find-MmaOnPath $env:Path
  if ($resolved -and (Test-Under $resolved $binDir)) {
    Say "verified: mma -> $resolved"
  } elseif ($resolved) {
    Say "warning: mma still resolves to $resolved instead of $launcher"
    if (Test-Under $resolved $npmPrefix) {
      Say "run: npm rm -g micro-models-agent"
    } else {
      Say "move $binDir before $(Split-Path -Parent $resolved) on PATH"
    }
  } else {
    Say "note: mma is not resolvable in this session; open a new terminal"
  }
  if ((Test-Path $bun) -and (Test-Path $mainJs)) {
    try { & $bun $mainJs --version | Out-Null } catch { }
  }
  Show-Mascot "happy"
  Say "installed MMA $version"
  # The verified tarball is no longer needed; a failed run keeps it for resume.
  Remove-Item $tar -Force -ErrorAction SilentlyContinue
  Say "open a new terminal, then run: mma setup   (and then: mma)"
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
