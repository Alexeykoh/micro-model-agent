#!/usr/bin/env sh
# MMA bootstrap installer — macOS / Linux.
#
# Downloads a self-contained release (bundled Bun runtime + app + prod deps)
# from GitHub Releases into ~/.mma and puts an `mma` launcher on PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/Alexeykoh/micro-model-agent/master/scripts/install.sh | bash
#
# Env:
#   MMA_INSTALL_BASE    mirror / release base (default: GitHub Releases)
#   MMA_HOME            install root (default: ~/.mma)
#   MMA_INSTALL_DRY_RUN=1  print the plan without network or writes
set -eu

MMA_REPO="Alexeykoh/micro-model-agent"
BASE="${MMA_INSTALL_BASE:-https://github.com/${MMA_REPO}/releases/latest/download}"
BASE="${BASE%/}"
MMA_HOME="${MMA_HOME:-$HOME/.mma}"
DRY="${MMA_INSTALL_DRY_RUN:-0}"

say() { printf 'mma: %s\n' "$*"; }
die() { printf 'mma: %s\n' "$*" >&2; exit 1; }

# --- detect platform -------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux) oskey="linux" ;;
  Darwin) oskey="mac" ;;
  *) die "unsupported OS: $os" ;;
esac
case "$arch" in
  x86_64 | amd64) archkey="x64" ;;
  arm64 | aarch64) archkey="arm64" ;;
  *) die "unsupported architecture: $arch" ;;
esac
key="${oskey}-${archkey}"
artifact="mma-${key}.tar.gz"

# --- fetch -----------------------------------------------------------------
fetch() { # url outfile
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die "neither curl nor wget is available"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    printf ''
  fi
}

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t mma)"
trap 'rm -rf "$tmp"' EXIT INT TERM

if [ "$DRY" = "1" ]; then
  say "dry-run: platform=$key"
  say "dry-run: manifest=$BASE/latest.json"
  say "dry-run: artifact=$BASE/$artifact"
  say "dry-run: install=$MMA_HOME/versions/<version> ; current=$MMA_HOME/current ; bin=$MMA_HOME/bin/mma"
  exit 0
fi

say "downloading $artifact …"
fetch "$BASE/latest.json" "$tmp/latest.json" || die "manifest fetch failed"
fetch "$BASE/$artifact" "$tmp/mma.tar.gz" || die "artifact download failed"

expected="$(sed -n "/\"$key\"/,/}/p" "$tmp/latest.json" | sed -n 's/.*"sha256": *"\([a-fA-F0-9]*\)".*/\1/p' | head -n1)"
if [ -n "$expected" ]; then
  actual="$(sha256_of "$tmp/mma.tar.gz")"
  if [ -z "$actual" ]; then
    say "warning: no sha256 tool found — skipping checksum"
  elif [ "$expected" != "$actual" ]; then
    die "checksum mismatch for $artifact (expected $expected, got $actual)"
  fi
else
  say "warning: checksum not found in manifest — skipping verification"
fi

mkdir -p "$tmp/pkg"
tar -xzf "$tmp/mma.tar.gz" -C "$tmp/pkg" || die "extraction failed"
[ -f "$tmp/pkg/VERSION" ] || die "invalid archive: VERSION missing"
version="$(tr -d '[:space:]' < "$tmp/pkg/VERSION")"

# --- install ---------------------------------------------------------------
mkdir -p "$MMA_HOME/versions" "$MMA_HOME/bin"
rm -rf "$MMA_HOME/versions/$version"
mv "$tmp/pkg" "$MMA_HOME/versions/$version"
ln -sfn "versions/$version" "$MMA_HOME/current.new"
rm -f "$MMA_HOME/current"
mv "$MMA_HOME/current.new" "$MMA_HOME/current"

printf '#!/usr/bin/env sh\nexec "%s/current/runtime/bun" "%s/current/app/main.js" "$@"\n' \
  "$MMA_HOME" "$MMA_HOME" > "$MMA_HOME/bin/mma"
chmod +x "$MMA_HOME/bin/mma"

# --- PATH ------------------------------------------------------------------
case ":${PATH:-}:" in
  *":$MMA_HOME/bin:"*) ;;
  *)
    line="export PATH=\"$MMA_HOME/bin:\$PATH\""
    added=0
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
      [ -f "$rc" ] || continue
      if ! grep -qF "$MMA_HOME/bin" "$rc" 2>/dev/null; then
        printf '\n# Added by MMA installer\n%s\n' "$line" >> "$rc"
        added=1
      fi
    done
    if [ "$added" = "0" ]; then
      say "add to PATH: $line"
    fi
    ;;
esac

# --- verify ----------------------------------------------------------------
if "$MMA_HOME/current/runtime/bun" "$MMA_HOME/current/app/main.js" --version >/dev/null 2>&1; then
  say "installed MMA $version"
else
  say "installed MMA $version (verification call failed — run: $MMA_HOME/bin/mma --version)"
fi

say "open a new terminal, then run: mma setup   (and then: mma)"
