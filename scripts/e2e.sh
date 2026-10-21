#!/bin/sh
# Runs the end-to-end tests in the Playwright Docker image (Chromium plus its system libraries),
# so the host needs neither. The app is built on the host first (E2E_SKIP_BUILD=1 skips that).
# The container has no network (`--network none`): the test servers are only reachable inside it,
# nothing is published on the host. Extra arguments go to `playwright test`.
set -eu
cd "$(dirname "$0")/.."

# The image tag follows the installed @playwright/test: browser build and library must match.
VERSION=$(node -p "require('./node_modules/@playwright/test/package.json').version" 2>/dev/null) || {
  echo "e2e: @playwright/test ist nicht installiert (npm ci ausführen)." >&2
  exit 1
}
IMAGE=mcr.microsoft.com/playwright:v${VERSION}-noble

if [ "${E2E_SKIP_BUILD:-0}" != 1 ]; then
  npm run build
fi

exec docker run --rm --init --shm-size=1g --network none \
  -v "$PWD":/work -w /work \
  -u "$(id -u):$(id -g)" -e HOME=/tmp -e CI="${CI:-}" -e E2E_WORKERS="${E2E_WORKERS:-}" \
  "$IMAGE" npx --no-install playwright test "$@"
