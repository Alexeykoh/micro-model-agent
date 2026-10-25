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
# Оборванный или побитый канал не должен требовать ручного перезапуска скрипта.
ATTEMPTS=3

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
# Одна попытка; если недокачанный файл уже есть, curl продолжит с него.
# wget докачку с конкретным `-O` не поддерживает — там файл качается заново.
fetch_once() { # url outfile -> non-zero on failure
  if command -v curl >/dev/null 2>&1; then
    if [ -f "$2" ]; then
      curl -fsSL -C - --connect-timeout 30 "$1" -o "$2"
    else
      curl -fsSL --connect-timeout 30 "$1" -o "$2"
    fi
  elif command -v wget >/dev/null 2>&1; then
    rm -f "$2"
    wget -q --timeout=30 -O "$2" "$1"
  else
    die "neither curl nor wget is available"
  fi
}

size_of() {
  wc -c < "$1" | tr -d '[:space:]'
}

if command -v sha256sum >/dev/null 2>&1; then
  SHA_TOOL=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  SHA_TOOL=shasum
else
  SHA_TOOL=""
fi

sha256_of() {
  case "$SHA_TOOL" in
    sha256sum) sha256sum "$1" | awk '{print $1}' ;;
    shasum) shasum -a 256 "$1" | awk '{print $1}' ;;
    *) printf '' ;;
  esac
}

# Скачивание с докачкой и повтором. Недокачанный файл продолжается с места
# обрыва; побитый (не сошёлся sha256) выбрасывается и качается заново.
fetch_verified() { # url outfile expected_size expected_sha label
  i=1
  while [ "$i" -le "$ATTEMPTS" ]; do
    if [ "$i" -gt 1 ]; then sleep $((i * 2)); fi
    if fetch_once "$1" "$2"; then
      have="$(size_of "$2" 2>/dev/null || printf 0)"
      if [ "$have" -gt "$3" ]; then
        rm -f "$2"
        have=0
      fi
      if [ "$have" -ne "$3" ]; then
        say "$5: incomplete download ($have of $3 bytes), retrying"
      else
        if [ -z "$SHA_TOOL" ]; then
          say "warning: no sha256 tool found — skipping checksum"
          return 0
        fi
        actual="$(sha256_of "$2")"
        if [ "$actual" = "$4" ]; then return 0; fi
        say "$5: checksum mismatch: discarding the download and retrying"
        rm -f "$2"
      fi
    else
      say "$5: download attempt $i failed, retrying"
    fi
    i=$((i + 1))
  done
  die "could not download $1 in $ATTEMPTS attempts; check your connection and run the installer again"
}

fetch_manifest() { # url outfile
  i=1
  while [ "$i" -le "$ATTEMPTS" ]; do
    if fetch_once "$1" "$2"; then return 0; fi
    if [ "$i" -lt "$ATTEMPTS" ]; then
      say "manifest fetch failed, retrying ($i/$ATTEMPTS)"
      sleep "$i"
    fi
    i=$((i + 1))
  done
  die "cannot fetch $1"
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

say "fetching manifest ..."
fetch_manifest "$BASE/latest.json" "$tmp/latest.json"

entry_block="$(sed -n "/\"$key\"/,/}/p" "$tmp/latest.json")"
expected="$(printf '%s\n' "$entry_block" | sed -n 's/.*"sha256": *"\([a-fA-F0-9]\{64\}\)".*/\1/p' | head -n1)"
expected_size="$(printf '%s\n' "$entry_block" | sed -n 's/.*"size": *\([0-9][0-9]*\).*/\1/p' | head -n1)"

if [ -z "$expected" ] || [ -z "$expected_size" ]; then
  die "manifest has no checksum/size for $key"
fi

say "downloading $artifact ..."
fetch_verified "$BASE/$artifact" "$tmp/mma.tar.gz" "$expected_size" \
  "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" "$artifact"

mkdir -p "$tmp/pkg"
tar -xzf "$tmp/mma.tar.gz" -C "$tmp/pkg" || die "extraction failed"
[ -f "$tmp/pkg/VERSION" ] || die "invalid archive: VERSION missing"
version="$(tr -d '[:space:]' < "$tmp/pkg/VERSION")"
case "$version" in
  "" | . | ..) die "invalid archive: unsafe VERSION '$version'" ;;
esac

# --- install ---------------------------------------------------------------
mkdir -p "$MMA_HOME/versions" "$MMA_HOME/bin"
staging="$MMA_HOME/versions/$version.tmp"
rm -rf "$staging"
mv "$tmp/pkg" "$staging"
# Replace by rename, never by delete-in-place: a failed rename leaves the live
# version untouched, rm -rf would delete its files one by one first.
previous="$MMA_HOME/versions/$version.old-$$"
if [ -e "$MMA_HOME/versions/$version" ]; then
  mv "$MMA_HOME/versions/$version" "$previous" 2>/dev/null ||
    die "version $version is in use; close MMA, then run the installer again"
fi
mv "$staging" "$MMA_HOME/versions/$version"
rm -rf "$previous" 2>/dev/null ||
  say "note: $previous will be removed on the next MMA start"

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
