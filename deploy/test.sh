#!/usr/bin/env bash
# Pre-switch test gate. The supervisor runs this from the release root after build.sh
# and switches only if it exits 0.
#
# The full `npm test` is ~18 minutes on the deploy host (measured), too slow to gate every
# deploy. This runs the type check, the frontend syntax check and the tests that cover what
# a bad deploy cannot recover from: the server booting, /api/status and the SSE init,
# auth, the route context, and the telemetry, health and reload pieces. `npm test` runs the rest.
set -euo pipefail

cd "$(dirname "$0")/.."
export CODEMAN_NO_AUTOSTART=1

tests=(
  test/telemetry.test.ts
  test/routes/telemetry-routes.test.ts
  test/telemetry-server.test.ts
  test/build-reload.test.ts
  test/deploy-healthcheck.test.ts
  test/http-contract.test.ts
  test/routes/system-routes.test.ts
  test/mocks/mock-route-context-completeness.test.ts
  test/auth-security.test.ts
  test/sse-registry-parity.test.ts
  test/server-index-title.test.ts
)

# A filter that matches no file makes vitest exit 0, so a renamed test must fail here instead.
for f in "${tests[@]}"; do
  [ -f "$f" ] || { echo "test.sh: $f does not exist" >&2; exit 1; }
done

npm run typecheck
npm run check:frontend-syntax
npm test -- "${tests[@]}"
