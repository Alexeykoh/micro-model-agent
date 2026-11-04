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
#   MMA_INSTALL_NO_PATH=1  do not change PATH (CI/tests/corporate)
#   MMA_NPM_PREFIX      override `npm prefix -g` for legacy-shim detection
set -eu

MMA_REPO="Alexeykoh/micro-model-agent"
BASE="${MMA_INSTALL_BASE:-https://github.com/${MMA_REPO}/releases/latest/download}"
BASE="${BASE%/}"
MMA_HOME="${MMA_HOME:-$HOME/.mma}"
DRY="${MMA_INSTALL_DRY_RUN:-0}"
NO_PATH="${MMA_INSTALL_NO_PATH:-0}"
# Оборванный или побитый канал не должен требовать ручного перезапуска скрипта.
ATTEMPTS=3

say() { printf 'mma: %s\n' "$*"; }
die() { printf 'mma: %s\n' "$*" >&2; exit 1; }

# --- look & feel ----------------------------------------------------------
# Colours and animation are strictly best-effort: a pipe/CI/NO_COLOR stays
# plain, so logs and tests never contain escape codes.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  ANIMATED=1
  C_ACCENT="$(printf '\033[38;5;183m')"
  C_OK="$(printf '\033[38;5;150m')"
  C_DIM="$(printf '\033[38;5;245m')"
  C_ERR="$(printf '\033[38;5;203m')"
  C_BOLD="$(printf '\033[1m')"
  C_RESET="$(printf '\033[0m')"
else
  ANIMATED=0
  C_ACCENT=""
  C_OK=""
  C_DIM=""
  C_ERR=""
  C_BOLD=""
  C_RESET=""
fi

banner() {
  printf '\n'
  printf '  %s+-------------+%s  %sMMA installer%s\n' "$C_ACCENT" "$C_RESET" "$C_BOLD" "$C_RESET"
  printf '  %s| []      []  |%s  %sGitHub Releases - %s%s\n' "$C_ACCENT" "$C_RESET" "$C_DIM" "$key" "$C_RESET"
  printf '  %s+-------------+%s  %shome: %s%s\n' "$C_ACCENT" "$C_RESET" "$C_DIM" "$MMA_HOME" "$C_RESET"
  printf '\n'
}

# One-line progress bar: 26 cells, percentage, sizes. The mascot stays above,
# the bar updates in place so a slow link looks alive instead of frozen.
draw_bar() { # done total label
  [ "$ANIMATED" = "1" ] || return 0
  total="${2:-0}"
  done_now="${1:-0}"
  width=26
  if [ "$total" -gt 0 ]; then pct=$((done_now * 100 / total)); else pct=0; fi
  [ "$pct" -gt 100 ] && pct=100
  fill=$((pct * width / 100))
  bar=""
  i=0
  while [ "$i" -lt "$width" ]; do
    if [ "$i" -lt "$fill" ]; then bar="$bar#"; else bar="$bar-"; fi
    i=$((i + 1))
  done
  printf '\r  %s[%s]%s %3d%%  %s%s/%s MB  %s%s' \
    "$C_ACCENT" "$bar" "$C_RESET" "$pct" "$C_DIM" "$(mb "$done_now")" "$(mb "$total")" "$3" "$C_RESET"
}

# True when $1 is $2 itself or lives under it.
under() {
  [ -n "${1:-}" ] && [ -n "${2:-}" ] || return 1
  case "$1" in "$2" | "$2"/*) return 0 ;; *) return 1 ;; esac
}

# PATH scan for an executable `mma` (no caches: `command -v` is fine in sh, but
# the same helper is reused for the post-install check).
find_mma_on_path() {
  old_ifs="$IFS"
  IFS=:
  for dir in ${PATH:-}; do
    [ -n "$dir" ] || continue
    if [ -f "$dir/mma" ] && [ -x "$dir/mma" ]; then
      IFS="$old_ifs"
      printf '%s\n' "$dir/mma"
      return 0
    fi
  done
  IFS="$old_ifs"
  return 1
}

# npm prefix for legacy detection: explicit override first, then `npm prefix -g`.
get_npm_prefix() {
  if [ -n "${MMA_NPM_PREFIX:-}" ]; then
    printf '%s\n' "${MMA_NPM_PREFIX%/}"
    return 0
  fi
  if command -v npm >/dev/null 2>&1; then
    prefix="$(npm prefix -g 2>/dev/null | head -n1 || true)"
    if [ -n "$prefix" ]; then
      printf '%s\n' "${prefix%/}"
      return 0
    fi
  fi
  return 1
}

# Retire (rename, never delete) npm launchers shadowing `mma`. Reversible: the
# backup name is printed. Needed because the npm prefix may sit in the system
# PATH, where a user-PATH prepend cannot win.
retire_legacy_npm_shims() { # prefix
  moved=0
  for path in "$1/mma" "$1/bin/mma"; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    backup="$path.legacy-npm.bak"
    rm -f "$backup"
    if mv "$path" "$backup" 2>/dev/null; then
      say "retired legacy npm launcher: $path (backup: $backup)"
      moved=1
    else
      say "warning: cannot move $path; remove it with: npm rm -g micro-models-agent"
    fi
  done
  if [ "$moved" = "1" ]; then
    say "after the new mma works, clean up npm: npm rm -g micro-models-agent"
  fi
}

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

banner

# --- legacy preflight ------------------------------------------------------
# The new launcher does not exist yet, so any `mma` outside $MMA_HOME/bin is a
# legacy copy. Classification as npm needs the npm prefix; without npm we still
# warn but never touch the file.
legacy_mma="$(find_mma_on_path || true)"
npm_prefix=""
legacy_is_npm=0
if [ -n "$legacy_mma" ] && ! under "$legacy_mma" "$MMA_HOME/bin"; then
  npm_prefix="$(get_npm_prefix || true)"
  if under "$legacy_mma" "$npm_prefix"; then legacy_is_npm=1; fi
fi

# --- fetch -----------------------------------------------------------------
# Одна попытка; если недокачанный файл уже есть, curl продолжит с него.
# wget докачку с конкретным `-O` не поддерживает — там файл качается заново.
fetch_once() { # url outfile [progress] -> non-zero on failure
  progress="${3:-}"
  if command -v curl >/dev/null 2>&1; then
    resume=""
    if [ -f "$2" ]; then resume="-C -"; fi
    if [ "$progress" = "1" ] && [ "$ANIMATED" = "1" ]; then
      # shellcheck disable=SC2086
      curl -fL -sS $resume --connect-timeout 30 --speed-limit 2048 --speed-time 60 "$1" -o "$2" &
      pid=$!
      while kill -0 "$pid" 2>/dev/null; do
        have="$(size_of "$2" 2>/dev/null || printf 0)"
        draw_bar "$have" "${PROGRESS_TOTAL:-0}" download
        sleep 1
      done
      if wait "$pid"; then status=0; else status=$?; fi
      draw_bar "${PROGRESS_TOTAL:-0}" "${PROGRESS_TOTAL:-0}" download
      printf '\n'
      return "$status"
    fi
    # shellcheck disable=SC2086
    curl -fL -sS $resume --connect-timeout 30 --speed-limit 2048 --speed-time 60 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    rm -f "$2"
    if [ "$progress" = "1" ] && [ "$ANIMATED" = "1" ]; then
      wget -q --timeout=30 -O "$2" "$1" &
      pid=$!
      while kill -0 "$pid" 2>/dev/null; do
        have="$(size_of "$2" 2>/dev/null || printf 0)"
        draw_bar "$have" "${PROGRESS_TOTAL:-0}" download
        sleep 1
      done
      if wait "$pid"; then status=0; else status=$?; fi
      draw_bar "${PROGRESS_TOTAL:-0}" "${PROGRESS_TOTAL:-0}" download
      printf '\n'
      return "$status"
    fi
    wget -q --timeout=30 -O "$2" "$1"
  else
    die "neither curl nor wget is available"
  fi
}

size_of() {
  wc -c < "$1" | tr -d '[:space:]'
}

mb() {
  awk -v b="${1:-0}" 'BEGIN { printf "%.1f", b / 1048576 }'
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
  PROGRESS_TOTAL="$3"
  if [ -f "$2" ]; then
    have="$(size_of "$2" 2>/dev/null || printf 0)"
    if [ "$have" -gt 0 ] && [ "$have" -lt "$3" ]; then
      say "$5: resuming at $(mb "$have") of $(mb "$3") MB"
    fi
  fi
  i=1
  while [ "$i" -le "$ATTEMPTS" ]; do
    if [ "$i" -gt 1 ]; then sleep $((i * 2)); fi
    if fetch_once "$1" "$2" 1; then
      have="$(size_of "$2" 2>/dev/null || printf 0)"
      if [ "$have" -gt "$3" ]; then
        rm -f "$2"
        have=0
      fi
      if [ "$have" -ne "$3" ]; then
        say "$5: incomplete download ($(mb "$have") of $(mb "$3") MB), retrying"
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
  die "could not download $1 in $ATTEMPTS attempts; rerun the installer to resume, or check your connection"
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
  if [ -n "$legacy_mma" ]; then
    say "dry-run: legacy=$legacy_mma"
  else
    say "dry-run: legacy=none"
  fi
  if [ "$legacy_is_npm" = "1" ]; then say "dry-run: npm-prefix=$npm_prefix"; fi
  if [ "$NO_PATH" = "1" ]; then
    say "dry-run: path=unchanged (MMA_INSTALL_NO_PATH=1); add manually: export PATH=\"$MMA_HOME/bin:\$PATH\""
  else
    say "dry-run: path=prepend $MMA_HOME/bin to shell rc"
  fi
  exit 0
fi

if [ "$legacy_is_npm" = "1" ]; then
  say "found legacy npm install: $legacy_mma"
elif [ -n "$legacy_mma" ]; then
  say "another mma is on PATH: $legacy_mma"
fi

say "fetching manifest ..."
fetch_manifest "$BASE/latest.json" "$tmp/latest.json"

# Архив живёт в стабильном каталоге, а не в одноразовом `$tmp`: после Ctrl+C
# повторный запуск продолжает загрузку, а не начинает 78 МБ заново.
DOWNLOAD_DIR="${MMA_DOWNLOAD_DIR:-${TMPDIR:-/tmp}/mma-download}"
mkdir -p "$DOWNLOAD_DIR"
tarball="$DOWNLOAD_DIR/$artifact"

entry_block="$(sed -n "/\"$key\"/,/}/p" "$tmp/latest.json")"
expected="$(printf '%s\n' "$entry_block" | sed -n 's/.*"sha256": *"\([a-fA-F0-9]\{64\}\)".*/\1/p' | head -n1)"
expected_size="$(printf '%s\n' "$entry_block" | sed -n 's/.*"size": *\([0-9][0-9]*\).*/\1/p' | head -n1)"

if [ -z "$expected" ] || [ -z "$expected_size" ]; then
  die "manifest has no checksum/size for $key"
fi

say "downloading $artifact (~$(mb "$expected_size") MB) ..."
say "interrupting is safe: rerun the same command and the download resumes"
fetch_verified "$BASE/$artifact" "$tarball" "$expected_size" \
  "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" "$artifact"

mkdir -p "$tmp/pkg"
tar -xzf "$tarball" -C "$tmp/pkg" || die "extraction failed"
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

# --- legacy shim + PATH ----------------------------------------------------
# The new launcher exists now, so the old npm one is redundant. Retire it even
# when PATH order looks fine: the npm prefix may sit in the SYSTEM PATH, where
# a user-PATH/shell-rc prepend cannot win.
if [ "$legacy_is_npm" = "1" ]; then retire_legacy_npm_shims "$npm_prefix"; fi

if [ "$NO_PATH" = "1" ]; then
  say "PATH not changed (MMA_INSTALL_NO_PATH=1); add manually: export PATH=\"$MMA_HOME/bin:\$PATH\""
else
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
fi
# Session PATH for the verification below; the parent shell is unaffected.
PATH="$MMA_HOME/bin:${PATH:-}"
export PATH

# --- verify ----------------------------------------------------------------
rm -f "$tarball"
resolved="$(find_mma_on_path || true)"
if [ -n "$resolved" ] && under "$resolved" "$MMA_HOME/bin"; then
  say "verified: mma -> $resolved"
elif [ -n "$resolved" ]; then
  say "warning: mma still resolves to $resolved instead of $MMA_HOME/bin/mma"
  if under "$resolved" "$npm_prefix"; then
    say "run: npm rm -g micro-models-agent"
  else
    say "move $MMA_HOME/bin before $(dirname "$resolved") on PATH"
  fi
else
  say "note: mma is not resolvable in this session; open a new terminal"
fi
if [ "$ANIMATED" = "1" ]; then
  printf '\r  %s[%s]%s %s100%%  ready%s\n' \
    "$C_OK" "##########################" "$C_RESET" "$C_OK" "$C_RESET"
fi
if "$MMA_HOME/current/runtime/bun" "$MMA_HOME/current/app/main.js" --version >/dev/null 2>&1; then
  say "installed MMA $version"
else
  say "installed MMA $version (verification call failed — run: $MMA_HOME/bin/mma --version)"
fi

say "open a new terminal, then run: mma setup   (and then: mma)"
