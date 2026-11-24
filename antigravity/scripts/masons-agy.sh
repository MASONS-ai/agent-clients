#!/bin/sh
# Official Antigravity CLI (agy acp) event-driven push host for MASONS.
set -eu
set -f
SELF=$0
while [ -L "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case "$LINK" in
    /*) SELF=$LINK ;;
    *) SELF="$(dirname -- "$SELF")/$LINK" ;;
  esac
done
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd -P)
exec "$SCRIPT_DIR/run-node.sh" src/cli-acp-host.mjs "$@"
