#!/bin/sh
# Prepares /data for the configured user, then hands over to the app (exec, so signals reach node).
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
export PUID PGID

if [ "$(id -u)" = "0" ]; then
  case "$PUID:$PGID" in
    *[!0-9:]*) echo "PUID and PGID must be numbers" >&2; exit 1 ;;
  esac
  if [ "$PUID" = "0" ] || [ "$PGID" = "0" ]; then
    echo "obsidian-web-vault does not run as root: PUID/PGID must not be 0" >&2
    exit 1
  fi
  # Only the app's own state; the vault is never chowned.
  chown -R "$PUID:$PGID" "${DATA_DIR:-/data}"
fi

exec /usr/local/bin/obsidian-web-vault "$@"
