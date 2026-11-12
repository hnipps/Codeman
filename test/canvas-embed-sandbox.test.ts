/**
 * A canvas embed's frame carries exactly the sandbox of an untrusted web tab. In particular it
 * never carries allow-popups-to-escape-sandbox: a popup that escapes the sandbox could open
 * `/webview/<cap>/...` unsandboxed on Codeman's origin, with the session cookie.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const UNTRUSTED = 'allow-scripts allow-forms allow-popups allow-downloads allow-modals';

describe('canvas embed sandbox', () => {
  it('matches the untrusted web-tab token list exactly', () => {
    const media = readFileSync('packages/canvas/src/media.ts', 'utf8');
    const embed = /export const EMBED_SANDBOX = '([^']*)';/.exec(media)?.[1];
    expect(embed).toBe(UNTRUSTED);
    expect(embed).not.toContain('allow-popups-to-escape-sandbox');
    const tabs = readFileSync('src/web/public/webview-tabs.js', 'utf8');
    const list = /const sandbox = \[([^\]]*)\];/.exec(tabs)?.[1];
    expect(
      list
        ?.match(/'([^']+)'/g)
        ?.map((t) => t.slice(1, -1))
        .join(' ')
    ).toBe(UNTRUSTED);
    expect(media).toMatch(/setAttribute\('sandbox', EMBED_SANDBOX\)|sandbox = EMBED_SANDBOX/);
  });
  it('sends the same sandbox as a response header for canvas frames, so it survives a new tab', async () => {
    const { CANVAS_FRAME_SANDBOX } = await import('../src/web/routes/webview-routes.js');
    expect(CANVAS_FRAME_SANDBOX).toBe(UNTRUSTED);
    const proxy = readFileSync('src/web/routes/webview-routes.ts', 'utf8');
    expect(proxy).toMatch(/origin\.kind === 'canvas' \? \[csp, `sandbox \$\{CANVAS_FRAME_SANDBOX\}`\]/);
  });
});
