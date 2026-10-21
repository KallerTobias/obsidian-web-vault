#!/bin/sh
# Runs the obsidian-web-vault CLI as the configured unprivileged user (PUID:PGID, default node = 1000:1000).
# Also usable via `docker exec <container> obsidian-web-vault setup-link`.
set -eu

umask "${UMASK:-002}"

if [ "$(id -u)" = "0" ]; then
  exec su-exec "${PUID:-1000}:${PGID:-1000}" node /app/dist/server.js "$@"
fi
# Already started unprivileged (e.g. `user:` in compose): nothing to drop.
exec node /app/dist/server.js "$@"
