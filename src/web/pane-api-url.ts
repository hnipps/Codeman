/**
 * @fileoverview The API URL a pane is handed as `CODEMAN_API_URL`.
 *
 * A pane outlives the server that created it, and its hooks call this URL for as long as
 * it runs. A blue-green deploy stops the colour that created the pane, so the supervisor
 * names a stable address in front of whichever colour is live (`CODEMAN_STABLE_API_URL`)
 * and panes get that instead of this server's own port. Only an http(s) URL on a loopback
 * host is taken: the hooks carry the hook secret, and the proxy it names is local.
 */

import { isLoopbackBindHost } from './network-auth-policy.js';

export function resolvePaneApiUrl(ownUrl: string, stableUrl: string | undefined): { url: string; warning?: string } {
  const raw = stableUrl?.trim();
  if (!raw) return { url: ownUrl };
  const refuse = (why: string) => ({
    url: ownUrl,
    warning: `CODEMAN_STABLE_API_URL ${why}; panes get this server's own URL, ${ownUrl}`,
  });
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return refuse('is not a URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return refuse('is not an http(s) URL');
  if (!isLoopbackBindHost(parsed.hostname)) return refuse('does not name a loopback host');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return refuse('carries credentials, a query or a fragment');
  }
  return { url: parsed.origin + parsed.pathname.replace(/\/+$/, '') };
}
