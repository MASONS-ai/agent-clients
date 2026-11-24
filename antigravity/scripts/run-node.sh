#!/bin/sh
# Hardened POSIX launcher for MASONS Antigravity plugin scripts.
# Clears unsafe Node env vars, disables globbing, resolves Node.js >= 24 from trusted
# non-world-writable locations (including Linux multi-hop symlinks), and confines
# execution strictly inside PLUGIN_ROOT.

set -eu
set -f

unset NODE_OPTIONS NODE_PATH NODE_REDIRECT_WARNINGS NODE_TLS_REJECT_UNAUTHORIZED

if [ "$#" -lt 1 ]; then
  printf 'run-node.sh: target script required\n' >&2
  exit 1
fi

SCRIPT_REL="$1"
shift

case "$SCRIPT_REL" in
  /*|*..*|*\\*)
    printf 'run-node.sh: target script must be a safe relative path under PLUGIN_ROOT\n' >&2
    exit 1
    ;;
  *.mjs)
    ;;
  *)
    printf 'run-node.sh: target script must end with .mjs\n' >&2
    exit 1
    ;;
esac

SELF_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PLUGIN_ROOT="$(cd "$SELF_DIR/.." && pwd -P)"
export PLUGIN_ROOT

TARGET_PATH="$PLUGIN_ROOT/$SCRIPT_REL"
if [ -L "$TARGET_PATH" ] || [ ! -f "$TARGET_PATH" ]; then
  printf 'run-node.sh: target script missing or symlink\n' >&2
  exit 1
fi

TARGET_DIR="$(cd "$(dirname "$TARGET_PATH")" && pwd -P)"
case "$TARGET_DIR/" in
  "$PLUGIN_ROOT/"*)
    ;;
  *)
    printf 'run-node.sh: target script escapes PLUGIN_ROOT\n' >&2
    exit 1
    ;;
esac
TARGET_REAL="$TARGET_DIR/$(basename "$TARGET_PATH")"

MY_UID="$(id -u)"

stat_meta() {
  # Try GNU stat (-c) first: BSD stat fails cleanly on -c with empty stdout, whereas GNU stat
  # interprets -f as --file-system and prints filesystem info to stdout.
  stat -c '%u %A' "$1" 2>/dev/null || stat -f '%u %Sp' "$1" 2>/dev/null || true
}

is_safe_path_entry() {
  _p="$1"
  _allow_group_write="${2:-0}"
  [ -n "$_p" ] || return 1
  case "$_p" in
    /*) ;;
    *) return 1 ;;
  esac
  [ -e "$_p" ] || [ -L "$_p" ] || return 1
  _meta="$(stat_meta "$_p")"
  [ -n "$_meta" ] || return 1
  _owner="${_meta%% *}"
  _mode="${_meta#* }"
  if [ "$_owner" != "0" ] && [ "$_owner" != "$MY_UID" ]; then
    return 1
  fi
  # Symlinks on Linux always report lrwxrwxrwx; ownership check applies to the symlink itself,
  # while permission bits apply to directories and resolved regular files.
  if [ -L "$_p" ]; then
    return 0
  fi
  case "$_mode" in
    ????????w?)
      return 1
      ;;
    ?????w????)
      [ "$_allow_group_write" = "1" ] || return 1
      ;;
  esac
  return 0
}

is_trusted_node() {
  _cand="$1"
  _sys_dir="${2:-0}"
  [ -x "$_cand" ] || return 1
  _cur="$_cand"
  _hops=0
  while [ "$_hops" -lt 16 ]; do
    _dir="$(cd "$(dirname "$_cur")" 2>/dev/null && pwd -P)" || return 1
    _base="$(basename "$_cur")"
    _full="$_dir/$_base"
    _dir_gw="$_sys_dir"
    case "$_dir" in
      /opt/*|/usr/*) _dir_gw=1 ;;
    esac
    is_safe_path_entry "$_dir" "$_dir_gw" || return 1
    is_safe_path_entry "$_full" 0 || return 1
    if [ ! -L "$_full" ]; then
      [ -f "$_full" ] || return 1
      break
    fi
    _link="$(readlink "$_full" 2>/dev/null || true)"
    [ -n "$_link" ] || return 1
    case "$_link" in
      /*) _cur="$_link" ;;
      *) _cur="$_dir/$_link" ;;
    esac
    _hops=$((_hops + 1))
  done
  [ "$_hops" -lt 16 ] || return 1

  # Run from PLUGIN_ROOT so version-manager shims cannot read untrusted workspace config files.
  _raw_ver="$(cd "$PLUGIN_ROOT" && "$_full" -v 2>/dev/null || true)"
  _ver="${_raw_ver#v}"
  _ver="${_ver%%.*}"
  case "$_ver" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$_ver" -ge 24 ] || return 1
  return 0
}

NODE_BIN=""
for _candidate in \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /usr/bin/node \
  /opt/local/bin/node
do
  if is_trusted_node "$_candidate" 1; then
    NODE_BIN="$_candidate"
    break
  fi
done

if [ -z "$NODE_BIN" ]; then
  for _candidate in \
    "${HOME:-}/.volta/bin/node" \
    "${HOME:-}/.local/share/mise/shims/node" \
    "${HOME:-}/.asdf/shims/node" \
    "${HOME:-}/.nvm/current/bin/node"
  do
    if is_trusted_node "$_candidate" 0; then
      NODE_BIN="$_candidate"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ] && [ -n "${HOME:-}" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  set +f
  for _candidate in "$HOME"/.nvm/versions/node/v2[4-9].*/bin/node "$HOME"/.nvm/versions/node/v[3-9][0-9].*/bin/node; do
    set -f
    if is_trusted_node "$_candidate" 0; then
      NODE_BIN="$_candidate"
      break
    fi
  done
  set -f
fi

if [ -z "$NODE_BIN" ] && [ -n "${HOME:-}" ] && [ -d "$HOME/.local/share/fnm/node-versions" ]; then
  set +f
  for _candidate in "$HOME"/.local/share/fnm/node-versions/v2[4-9].*/installation/bin/node "$HOME"/.local/share/fnm/node-versions/v[3-9][0-9].*/installation/bin/node; do
    set -f
    if is_trusted_node "$_candidate" 0; then
      NODE_BIN="$_candidate"
      break
    fi
  done
  set -f
fi

# Trusted prefix fallback on PATH (supports CI toolcache such as /opt/hostedtoolcache without executing arbitrary repo bins).
if [ -z "$NODE_BIN" ] && [ -n "${PATH:-}" ]; then
  _old_ifs="$IFS"
  IFS=:
  for _pdir in $PATH; do
    case "$_pdir" in
      *..*|*"/./"*)
        continue
        ;;
      /opt/*|/usr/*)
        if is_trusted_node "$_pdir/node" 1; then
          NODE_BIN="$_pdir/node"
          break
        fi
        ;;
      "${HOME:-}/.nvm/"*|"${HOME:-}/.local/share/fnm/"*|"${HOME:-}/.volta/"*|"${HOME:-}/.asdf/"*|"${HOME:-}/.local/share/mise/"*)
        if is_trusted_node "$_pdir/node" 0; then
          NODE_BIN="$_pdir/node"
          break
        fi
        ;;
    esac
  done
  IFS="$_old_ifs"
fi

if [ -z "$NODE_BIN" ]; then
  printf 'run-node.sh: Node.js >= 24 not found in trusted paths\n' >&2
  exit 127
fi

exec "$NODE_BIN" -- "$TARGET_REAL" "$@"
