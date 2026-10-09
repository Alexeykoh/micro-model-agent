# MMA bootstrap installer — Windows (PowerShell 5.1+).
#
# Downloads a self-contained release (bundled Bun runtime + app + prod deps)
# from GitHub Releases into $env:USERPROFILE\.mma and adds an `mma` launcher
# to PATH.
#
#   irm https://raw.githubusercontent.com/Alexeykoh/micro-model-agent/master/scripts/install.ps1 | iex
#
# Env:
#   MMA_INSTALL_BASE    mirror / release base (default: GitHub Releases)
#   MMA_HOME            install root (default: %USERPROFILE%\.mma)
#   MMA_INSTALL_DRY_RUN=1  print the plan without network or writes
$ErrorActionPreference = "Stop"
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }

$MmaRepo = "Alexeykoh/micro-model-agent"
$Base = if ($env:MMA_INSTALL_BASE) { $env:MMA_INSTALL_BASE.TrimEnd('/') } else { "https://github.com/$MmaRepo/releases/latest/download" }
$MmaHome = if ($env:MMA_HOME) { $env:MMA_HOME } else { Join-Path $env:USERPROFILE ".mma" }
$Dry = $env:MMA_INSTALL_DRY_RUN -eq "1"

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

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("mma-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Say "fetching manifest ..."
  $manifest = Invoke-RestMethod -Uri "$Base/latest.json" -UseBasicParsing
  $entry = $manifest.artifacts.PSObject.Properties[$key].Value
  if (-not $entry) { Die "platform $key not found in manifest" }

  $tar = Join-Path $tmp "mma.tar.gz"
  Say "downloading $artifact ..."
  Invoke-WebRequest -Uri "$Base/$($entry.url)" -OutFile $tar -UseBasicParsing

  if ($entry.sha256) {
    $actual = (Get-FileHash -Path $tar -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $entry.sha256.ToLower()) { Die "checksum mismatch for $artifact" }
  }

  $pkg = Join-Path $tmp "pkg"
  New-Item -ItemType Directory -Path $pkg | Out-Null
  & tar -xzf $tar -C $pkg
  if ($LASTEXITCODE -ne 0) { Die "extraction failed" }
  $version = (Get-Content (Join-Path $pkg "VERSION") -Raw).Trim()
  if (-not $version) { Die "invalid archive: VERSION missing" }

  $versions = Join-Path $MmaHome "versions"
  $binDir = Join-Path $MmaHome "bin"
  New-Item -ItemType Directory -Force -Path $versions, $binDir | Out-Null
  $target = Join-Path $versions $version
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Move-Item $pkg $target

  $current = Join-Path $MmaHome "current"
  if (Test-Path $current) { Remove-Item -Recurse -Force $current }
  New-Item -ItemType Junction -Path $current -Target $target | Out-Null

  $launcher = Join-Path $binDir "mma.cmd"
  $content = "@echo off`r`n`"$MmaHome\current\runtime\bun.exe`" `"$MmaHome\current\app\main.js`" %*`r`n"
  Set-Content -Path $launcher -Value $content -Encoding ASCII

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -notlike "*$binDir*") {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $binDir } else { "$userPath;$binDir" }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Say "added $binDir to user PATH (restart your terminal)"
  }

  & (Join-Path $current "runtime\bun.exe") (Join-Path $current "app\main.js") --version | Out-Null
  Say "installed MMA $version"
  Say "open a new terminal, then run: mma setup   (and then: mma)"
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
