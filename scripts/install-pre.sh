#!/usr/bin/env sh
# MMA bootstrap installer - pre-release channel (macOS / Linux).
#
# Thin wrapper: points the stable installer at the current pre-release assets.
# The installer logic (resume, sha256, PATH, launcher, rollback) stays in
# install.sh; this file only pins the channel.
#
#   curl -fsSL https://raw.githubusercontent.com/Alexeykoh/micro-model-agent/pre/scripts/install-pre.sh | bash
#
# Env:
#   MMA_INSTALL_BASE    overrides the pre-release base (CI/tests/mirrors)
#   all other MMA_* vars are passed through to install.sh unchanged
set -eu

PRE_TAG="v0.26.0-pre.1"
MMA_REPO="Alexeykoh/micro-model-agent"
RAW="https://raw.githubusercontent.com/${MMA_REPO}/pre/scripts"

if [ -z "${MMA_INSTALL_BASE:-}" ]; then
  MMA_INSTALL_BASE="https://github.com/${MMA_REPO}/releases/download/${PRE_TAG}"
  export MMA_INSTALL_BASE
fi

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t mma-pre)"
trap 'rm -rf "$tmp"' EXIT INT TERM

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$RAW/install.sh" -o "$tmp/install.sh"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$tmp/install.sh" "$RAW/install.sh"
else
  printf 'mma: neither curl nor wget is available\n' >&2
  exit 1
fi

sh "$tmp/install.sh" "$@"
