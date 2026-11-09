# Intent: Load the isolated Mermaid renderer through an authenticated parent

**Status:** Implemented and verified

## Problem statement

The merged renderer works in browser tests without login, but its production
iframe times out behind authentication. Deployment was rolled back through the
supervisor. The agent command and recoverable native bundle already work.

## Proposed outcome

Mermaid diagrams render in authenticated Markdown readers. The parent fetches
the protected renderer document, then loads it into the same opaque sandbox
without giving the frame credentials or exempting an asset from authentication.
Verify the built production UI before redeploying.

## Affected users and systems

Authenticated Markdown readers, the lazy iframe loader and its browser tests.

## Constraints

- Keep the frame opaque, network-disabled and bounded by the existing timeout.
- Preserve source/error fallback, message checks, and inert image display.
- Do not weaken authentication, lost-frame recovery, CSP or the sanitizer.
- Keep the offline command and native runtime behavior unchanged.
- Merge and deploy only through the supervisor after verification.

## Open questions

None. Authentication makes the lost-frame handler intercept the static HTML
iframe navigation before the renderer runs. Parent fetching avoids that path.

The existing browser suite now enables login. Its first Markdown case failed
with the production timeout before the fix; all five cases pass afterward.
The built production assets also render a real diagram in an authenticated,
isolated test server, retaining source and the opaque sandbox. The production
build, static checks and all 309 supervisor-gate tests pass.
