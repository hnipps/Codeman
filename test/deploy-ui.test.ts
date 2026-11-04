/**
 * @fileoverview Frontend test for deploy-ui.js: the overview poll must not replace the rollback
 * buttons when nothing changed, or a tap that lands mid-rewrite hits a detached node and the click
 * is lost (the Confirm button swallowed taps every 3 seconds). Builds a JSDOM window in-test and
 * evaluates the real module against it, like admin-ui.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const DEPLOY_UI = readFileSync(new URL('../src/web/public/deploy-ui.js', import.meta.url), 'utf-8');

const OVERVIEW = {
  configured: true,
  busy: false,
  live: { sha: 'aaaaaaa1111111', since: '2026-11-03T20:00:00.000Z' },
  releases: [
    { sha: 'aaaaaaa1111111', builtAt: '2026-11-03T19:00:00.000Z', live: true },
    { sha: 'bbbbbbb2222222', builtAt: '2026-11-02T19:00:00.000Z', live: false },
  ],
  recent: [{ action: 'deploy', sha: 'aaaaaaa1111111', startedAt: '2026-11-03T19:30:00.000Z', outcome: 'success' }],
};

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

async function boot() {
  const dom = new JSDOM(
    `<!doctype html><body>
      <div class="modal active" id="appSettingsModal"><nav class="set-rail"><div class="set-rail-items"></div></nav><div class="set-doc"></div></div>
    </body>`,
    { url: 'http://localhost/', runScripts: 'outside-only' }
  );
  const win = dom.window as unknown as Window & typeof globalThis;
  const posts: unknown[] = [];
  win.fetch = (async (path: string, init?: { body?: string }) => {
    if (path === '/api/deploy/rollback') {
      posts.push(JSON.parse(init!.body!));
      return { ok: true, json: async () => ({ success: true, data: { requestId: 'r1' } }) };
    }
    return { ok: true, json: async () => ({ success: true, data: structuredClone(OVERVIEW) }) };
  }) as unknown as typeof fetch;
  (win as unknown as { eval: (s: string) => void }).eval(DEPLOY_UI);
  await settle();
  // The poll's tick runs refresh(); clicking the rail entry runs the same refresh without a 3s wait.
  const poll = async () => {
    (win.document.querySelector('[data-section="settings-deploys"]') as HTMLElement).click();
    await settle();
  };
  return { win, posts, poll };
}

describe('deploy-ui poll', () => {
  it('keeps the Confirm button node across a poll, so a tap during the refresh still lands', async () => {
    const { win, posts, poll } = await boot();
    (win.document.querySelector('[data-act="ask"][data-target="bbbbbbb2222222"]') as HTMLElement).click();
    const confirm = win.document.querySelector('[data-act="confirm"]') as HTMLButtonElement;
    expect(confirm).toBeTruthy();

    await poll();
    expect(win.document.querySelector('[data-act="confirm"]')).toBe(confirm);
    expect(confirm.isConnected).toBe(true);

    confirm.click();
    await settle();
    expect(posts).toEqual([{ target: 'bbbbbbb2222222' }]);
  });

  it('keeps the roll back buttons across a poll that returns the same overview', async () => {
    const { win, poll } = await boot();
    const btn = win.document.querySelector('[data-act="ask"][data-target="previous"]');
    await poll();
    expect(win.document.querySelector('[data-act="ask"][data-target="previous"]')).toBe(btn);
  });
});
