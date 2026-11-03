#!/usr/bin/env bash
# Build one release. The supervisor runs this from the release root.
#
# The stamp lives inside node_modules on purpose: the supervisor hard-links a
# node_modules from an earlier release with the same lockfile hash, and the stamp
# must travel with the tree it vouches for. `npm ci` deletes node_modules first, so
# an interrupted install never leaves a stamp behind.
set -euo pipefail

cd "$(dirname "$0")/.."

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

stamp=node_modules/.codeman-lockfile-sha256
lock_hash=$(hash_file package-lock.json)

if [ -d node_modules ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$lock_hash" ]; then
  echo "build: package-lock.json unchanged since the last install, skipping npm ci"
else
  CODEMAN_NO_AUTOSTART=1 npm ci --no-audit --no-fund
  printf '%s\n' "$lock_hash" > "$stamp"
fi

npm run build
