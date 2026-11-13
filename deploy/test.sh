#!/usr/bin/env bash
# Pre-switch test gate. The supervisor runs this from the release root after build.sh
# and switches only if it exits 0.
#
# The full `npm test` took about 18 minutes when measured, too slow to gate every
# deploy. This runs the type check, the frontend syntax check and the tests that cover what
# a bad deploy cannot recover from: the server booting, /api/status and the SSE init,
# auth, the route context, the telemetry, health and reload pieces, and the deploy role
# handoff the overlap of two colours depends on. `npm test` runs the rest.
set -euo pipefail

cd "$(dirname "$0")/.."
export CODEMAN_NO_AUTOSTART=1

tests=(
  test/canvas-commands.test.ts
  test/canvas-screenshot.test.ts
  test/mcp-canvas-tools.test.ts
  test/canvas-edit-queue.test.ts
  test/canvas-viewport.test.ts
  test/canvas-operations.test.ts
  test/canvas-store.test.ts
  test/routes/canvas-routes.test.ts
  test/canvas-media-compat.test.ts
  test/canvas-assets.test.ts
  test/link-preview.test.ts
  test/canvas-comments.test.ts
  test/canvas-context.test.ts
  test/canvas-view-registry.test.ts
  test/canvas-conversations.test.ts
  test/canvas-context-resolve.test.ts
  test/canvas-conversation-thread.test.ts
  test/canvas-conversation-delivery.test.ts
  test/canvas-conversation-session.test.ts
  test/canvas-thread-reply.test.ts
  test/canvas-thread-requests.test.ts
  test/canvas-tasks.test.ts
  test/canvas-task-routes.test.ts
  test/telemetry.test.ts
  test/routes/telemetry-routes.test.ts
  test/telemetry-server.test.ts
  test/telemetry-redact.test.ts
  test/telemetry-query.test.ts
  test/build-reload.test.ts
  test/deploy-healthcheck.test.ts
  test/deploy-role.test.ts
  test/routes/deploy-routes.test.ts
  test/deploy-control.test.ts
  test/routes/deploy-control-routes.test.ts
  test/deploy-colours.test.ts
  test/deploy-handoff.test.ts
  test/deploy-env-switches.test.ts
  test/http-contract.test.ts
  test/routes/system-routes.test.ts
  test/mocks/mock-route-context-completeness.test.ts
  test/auth-security.test.ts
  test/auth-session-store.test.ts
  test/deploy-colours-auth.test.ts
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
