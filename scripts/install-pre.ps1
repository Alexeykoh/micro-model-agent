# MMA bootstrap installer - pre-release channel (Windows, PowerShell 5.1+).
#
# Thin wrapper: points the stable installer at the current pre-release assets.
# The installer logic (resume, sha256, PATH, launcher, rollback) stays in
# install.ps1; this file only pins the channel.
#
#   irm https://raw.githubusercontent.com/Alexeykoh/micro-model-agent/pre/scripts/install-pre.ps1 | iex
#
# This file is deliberately ASCII-only for PowerShell 5.1 (no BOM = ANSI).
#
# Env:
#   MMA_INSTALL_BASE    overrides the pre-release base (CI/tests/mirrors)
#   all other MMA_* vars are passed through to install.ps1 unchanged
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$PreTag = "v0.26.0-pre.1"
$MmaRepo = "Alexeykoh/micro-model-agent"
$Raw = "https://raw.githubusercontent.com/$MmaRepo/pre/scripts"

if (-not $env:MMA_INSTALL_BASE) {
  $env:MMA_INSTALL_BASE = "https://github.com/$MmaRepo/releases/download/$PreTag"
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }

$body = (Invoke-WebRequest -Uri "$Raw/install.ps1" -UseBasicParsing).Content
Invoke-Expression $body
