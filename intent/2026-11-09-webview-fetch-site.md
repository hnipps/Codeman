# Intent: a proxied web tab can submit to an app that checks Sec-Fetch-Site

**Status:** Draft

## Problem statement

A web tab is a sandboxed frame with an opaque origin, so the browser labels the page's own requests `Sec-Fetch-Site: cross-site`. The proxy rewrites `Origin` and `Referer` to the upstream's origin and relays `Sec-Fetch-Site` unchanged. An upstream that checks that header answers every write with 403.

Plannotator is such an app. Opened as a preview, its page renders, and its feedback request is refused, so a review can never be sent from a web tab.

## Proposed outcome

The proxy relabels a `Sec-Fetch-Site` header that the browser sent as `same-origin`, like `Origin`. A client that sent no such header gets none. An agent can then run `plannotator annotate <file> --json` as a preview, and the reviewer's feedback comes back on the command's standard output.

## Affected users and systems

- Anyone who opens a web tab or a preview for an app that checks `Sec-Fetch-Site`.
- `buildUpstreamRequestHeaders()` in `src/web/webview-proxy.ts`.

## Constraints

- The capability in the URL stays the only thing that admits a request to the proxy. This change does not widen who can reach an upstream.
- Trusted and sandboxed web tabs keep their current cookie and sandbox rules.

## Open questions

None.
