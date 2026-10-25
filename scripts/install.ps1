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
$ErrorActionPreference = "Stop"
# PS 5.1 redraws a progress bar per block: that alone makes an 80 MB download slow.
$ProgressPreference = "SilentlyContinue"
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }

$MmaRepo = "Alexeykoh/micro-model-agent"
$Base = if ($env:MMA_INSTALL_BASE) { $env:MMA_INSTALL_BASE.TrimEnd('/') } else { "https://github.com/$MmaRepo/releases/latest/download" }
$MmaHome = if ($env:MMA_HOME) { $env:MMA_HOME } else { Join-Path $env:USERPROFILE ".mma" }
$Dry = $env:MMA_INSTALL_DRY_RUN -eq "1"
# A flaky or slow link must not require a manual re-run of the installer.
$Attempts = 3

function Say([string]$m) { Write-Host "mma: $m" }
function Die([string]$m) { Write-Error "mma: $m"; exit 1 }

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

if ($Dry) {
  Say "dry-run: platform=$key"
  Say "dry-run: manifest=$Base/latest.json"
  Say "dry-run: artifact=$Base/$artifact"
  Say "dry-run: install=$MmaHome\versions\<version> ; current=$MmaHome\current ; bin=$MmaHome\bin\mma.cmd"
  exit 0
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
          # --progress-bar: a silent 78 MB download looks frozen. --speed-limit
          # aborts a stalled transfer so the retry loop resumes instead of
          # hanging until the user gives up.
          $curlArgs = @(
            "-fL", "--progress-bar", "--connect-timeout", "30",
            "--speed-limit", "2048", "--speed-time", "60", "-o", $out
          )
          if ($have -gt 0) { $curlArgs += @("-C", "-") }
          $curlArgs += $uri
          & curl.exe @curlArgs
          if ($LASTEXITCODE -ne 0) { throw "curl exited with code $LASTEXITCODE" }
        } else {
          # Windows PowerShell cannot resume with Invoke-WebRequest: start over.
          if (Test-Path $out) { Remove-Item $out -Force }
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
  & tar -xzf $tar -C $pkg
  if ($LASTEXITCODE -ne 0) { Die "extraction failed" }

  $versionFile = Join-Path $pkg "VERSION"
  if (-not (Test-Path $versionFile)) { Die "invalid archive: VERSION missing" }
  $version = (Get-Content $versionFile -Raw).Trim()
  if ($version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') {
    Die "invalid archive: unsafe VERSION '$version'"
  }

  $versions = Join-Path $MmaHome "versions"
  $binDir = Join-Path $MmaHome "bin"
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

  # The session PATH counts too: when the caller already added bin (CI, tests,
  # a re-run in the same window) the user registry must not be touched.
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($userPath -notlike "*$binDir*") -and ($env:Path -notlike "*$binDir*")) {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $binDir } else { "$userPath;$binDir" }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Say "added $binDir to user PATH (restart your terminal)"
  }

  $bun = Join-Path $current "runtime\bun.exe"
  $mainJs = Join-Path $current "app\main.js"
  if ((Test-Path $bun) -and (Test-Path $mainJs)) {
    try { & $bun $mainJs --version | Out-Null } catch { }
  }
  Say "installed MMA $version"
  # The verified tarball is no longer needed; a failed run keeps it for resume.
  Remove-Item $tar -Force -ErrorAction SilentlyContinue
  Say "open a new terminal, then run: mma setup   (and then: mma)"
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
