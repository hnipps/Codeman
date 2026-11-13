/**
 * @fileoverview Canvas shell routes (PC13): what `/`, `/classic`, `/?view=classic` and `/canvas/:id` answer for
 * each combination of the two settings, with and without a reverse-proxy base path. With either setting off the
 * root page is byte-identical to what it was; with both on it is the canvas document, never a redirect; a missing
 * canvas file gives the dashboard with the notice.
 *
 * Port: 0 (app.inject, no listener is used).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';

type Inject = (o: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}) => Promise<{ statusCode: number; body: string; headers: Record<string, string | undefined> }>;

const settings = (value: Record<string, unknown>) => writeFileSync(dataPath('settings.json'), JSON.stringify(value));
const COMBOS = [
  { canvasEnabled: false, canvasShellEnabled: false },
  { canvasEnabled: true, canvasShellEnabled: false },
  { canvasEnabled: false, canvasShellEnabled: true },
  { canvasEnabled: true, canvasShellEnabled: true },
] as const;
const isShell = (c: (typeof COMBOS)[number]) => c.canvasEnabled && c.canvasShellEnabled;
const SHELL_MARKERS = [
  '__CODEMAN_SHELL__',
  'data-canvas',
  'data-shell',
  'codeman-canvas-',
  '__canvasBoot',
  'canvas.js',
  'canvas-home.js',
  'canvas.css',
];

for (const base of ['', '/x']) {
  describe(`canvas shell routes${base ? ' under a base path' : ''}`, () => {
    let server: WebServer, inject: Inject, alpha: string, beta: string;
    const get = (url: string, headers?: Record<string, string>) => inject({ method: 'GET', url: base + url, headers });

    beforeAll(async () => {
      // Both runs share this file's temporary data directory; each starts with no workspace.
      rmSync(dataPath('workspaces.json'), { force: true });
      for (const name of ['alpha', 'beta']) mkdirSync(resolve(resolveCasesDir(), name), { recursive: true });
      settings({});
      server = new WebServer(0, false, true, undefined, undefined, undefined, base);
      await server.start();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inject = (server as any).app.inject.bind((server as any).app);
    }, 60000);
    afterAll(async () => {
      await server?.stop();
    }, 60000);

    it('answers the first-run page on `/` while the person has no workspace', async () => {
      settings(COMBOS[3]);
      const r = await get('/');
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('<html lang="en" data-canvas data-shell>');
      expect(r.body).toContain('<meta name="codeman-canvas-workspace" content="" />');
      expect(r.body).toMatch(/<script type="module" src="canvas-home\.js(\?v=\d+)?">/);
      expect(r.body).not.toMatch(/src="canvas\.js/);
      alpha = workspaceForCase('alpha').id;
      beta = workspaceForCase('beta').id;
    });

    it('leaves `/` byte-identical unless both settings are on, whatever the query says', async () => {
      settings({});
      const plain = (await get('/')).body;
      expect(plain).toContain('<title>');
      // Nothing the shell adds to a document is in it.
      for (const marker of SHELL_MARKERS) expect(plain, marker).not.toContain(marker);
      // The reference is the dashboard template on disk, not a second run of the code under test: the page is
      // that file, line for line, plus only the one-line `window.__…` facts the dashboard has always injected.
      const template = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');
      const normal = (line: string) =>
        line
          .replace(/\?v=\d+/g, '')
          .replace(/<title>[^<]*<\/title>/, '<title></title>')
          .replace(/<base href="[^"]*">/, '<base href="/">');
      const served = plain.split('\n').map(normal);
      const added: string[] = [];
      let at = 0;
      for (const line of template.split('\n').map(normal)) {
        while (at < served.length && served[at] !== line) added.push(served[at++]!);
        expect(at, `template line missing from the page: ${line}`).toBeLessThan(served.length);
        at++;
      }
      added.push(...served.slice(at));
      for (const line of added) expect(line).toMatch(/^\s*<script>window\.__[A-Za-z]\w*\s*=.*<\/script>$/);
      expect(added.length).toBeLessThanOrEqual(8);
      const shapes: { url: string; headers?: Record<string, string> }[] = [
        { url: '/' },
        { url: '/?view=classic' },
        { url: '/?view=classic&canvas=failed&reason=load' },
        { url: '/?session=abc' },
        { url: '/', headers: { cookie: `codeman_canvas_ws=${alpha}` } },
        { url: '/', headers: { accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } },
        { url: '/classic' },
      ];
      for (const combo of [{}, ...COMBOS.filter((c) => !isShell(c))]) {
        settings(combo);
        for (const { url, headers } of shapes) {
          const label = `${JSON.stringify(combo)} ${url} ${JSON.stringify(headers ?? {})}`;
          const r = await get(url, headers);
          // `/index.html` never took part in the landing decision: `/` answers what it answers for this request.
          const index = await get('/index.html', headers);
          expect(r.statusCode, label).toBe(200);
          expect(index.statusCode, label).toBe(200);
          expect(r.body === index.body, label).toBe(true);
          expect(r.body === plain, label).toBe(true);
          expect(r.headers['cache-control']).toBe('no-cache');
        }
      }
    });

    it('follows the setting table for `/`, `/classic` and `/canvas/:id`, and never redirects `/`', async () => {
      for (const combo of COMBOS) {
        settings(combo);
        const root = await get('/');
        expect(root.statusCode).toBe(200);
        expect(root.headers.location).toBeUndefined();
        expect(root.body.includes('data-canvas'), JSON.stringify(combo)).toBe(isShell(combo));
        const classic = await get('/classic');
        expect(classic.statusCode).toBe(200);
        expect(classic.body).not.toContain('data-canvas');
        expect(classic.body).not.toMatch(/canvas(-home)?\.js|canvas\.css/);
        expect(classic.body.includes('window.__CODEMAN_SHELL__={"on":true,"notice":null}')).toBe(isShell(combo));
        const page = await get(`/canvas/${alpha}`);
        expect(page.statusCode).toBe(combo.canvasEnabled ? 200 : 404);
        if (combo.canvasEnabled) {
          expect(page.body.includes('<meta name="codeman-canvas-shell" content="on" />')).toBe(isShell(combo));
          expect(page.body.includes('data-shell>')).toBe(isShell(combo));
          expect(page.body).toContain('<meta name="codeman-canvas-viewer" content="@single" />');
          expect(page.body).toContain(`<base href="${base}/" />`);
        }
      }
    });

    it('opens the remembered workspace, then the last used case, then the first, and ignores a bad cookie', async () => {
      const shown = (body: string) => /name="codeman-canvas-workspace" content="([^"]*)"/.exec(body)?.[1];
      settings(COMBOS[3]);
      expect(shown((await get('/')).body)).toBe(alpha);
      expect(shown((await get('/', { cookie: `a=1; codeman_canvas_ws=${beta}` })).body)).toBe(beta);
      for (const cookie of ['codeman_canvas_ws=nope', 'codeman_canvas_ws=../../x', 'codeman_canvas_ws=%E0%A4%A'])
        expect(shown((await get('/', { cookie })).body)).toBe(alpha);
      settings({ ...COMBOS[3], lastUsedCase: 'beta' });
      expect(shown((await get('/')).body)).toBe(beta);
      expect(shown((await get('/', { cookie: `codeman_canvas_ws=${alpha}` })).body)).toBe(alpha);
      const r = await get('/');
      expect(r.body).toMatch(/<script type="module" src="canvas\.js\?v=\d+">/);
      expect(r.body).toContain(`<base href="${base}/" />`);
    });

    it('honours view=classic with the shell on, with a notice only from the fixed list', async () => {
      settings(COMBOS[3]);
      const plain = await get('/?view=classic');
      expect(plain.body).not.toContain('data-canvas');
      expect(plain.body).toContain('window.__CODEMAN_SHELL__={"on":true,"notice":null}');
      for (const reason of ['load', 'boot', 'missing'])
        expect((await get(`/?view=classic&canvas=failed&reason=${reason}`)).body).toContain(
          `window.__CODEMAN_SHELL__={"on":true,"notice":"${reason}"}`
        );
      const hostile = await get('/?view=classic&canvas=failed&reason=%3C/script%3E%3Cscript%3Ealert(1)');
      expect(hostile.body).toContain('window.__CODEMAN_SHELL__={"on":true,"notice":"boot"}');
      expect(hostile.body).not.toContain('alert(1)');
    });

    it('shows the dashboard with the notice, not a redirect or an error, when a canvas file is missing', async () => {
      settings(COMBOS[3]);
      const present = server.canvasFilesPresent.bind(server);
      expect(present()).toBe(true);
      server.canvasFilesPresent = () => false;
      try {
        const root = await get('/');
        expect(root.statusCode).toBe(200);
        expect(root.headers.location).toBeUndefined();
        expect(root.body).not.toContain('data-canvas');
        expect(root.body).toContain('window.__CODEMAN_SHELL__={"on":true,"notice":"missing"}');
        // A reload of the address the shell wrote goes back to `/`, which is the dashboard with the notice.
        const reload = await get(`/canvas/${alpha}`);
        expect(reload.statusCode).toBe(302);
        expect(reload.headers.location).toBe(`${base}/`);
        expect((await get('/classic')).statusCode).toBe(200);
        // Off the shell the canvas is a tab in the dashboard and keeps its plain answer.
        settings(COMBOS[1]);
        expect((await get(`/canvas/${alpha}`)).statusCode).toBe(503);
      } finally {
        server.canvasFilesPresent = present;
      }
    });

    it('checks the real files: a canvas file that is gone from the public directory counts as missing', () => {
      const file = resolve(import.meta.dirname, '../src/web/public/canvas-home.js');
      expect(existsSync(file)).toBe(true);
      const saved = readFileSync(file);
      rmSync(file);
      try {
        expect(server.canvasFilesPresent()).toBe(false);
      } finally {
        writeFileSync(file, saved);
      }
      expect(server.canvasFilesPresent()).toBe(true);
    });

    it('shows the dashboard when the workspace registry does not parse', async () => {
      settings(COMBOS[3]);
      const path = dataPath('workspaces.json');
      const saved = readFileSync(path, 'utf8');
      writeFileSync(path, '{ not json');
      try {
        const root = await get('/');
        expect(root.statusCode).toBe(200);
        expect(root.body).toContain('window.__CODEMAN_SHELL__={"on":true,"notice":"missing"}');
      } finally {
        writeFileSync(path, saved);
      }
    });

    it('still answers a framed, credential-free `/` with the lost-frame page, shell on or off', async () => {
      const framed = { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', accept: 'text/html' };
      settings({});
      const before = await get('/', framed);
      settings(COMBOS[3]);
      const after = await get('/', framed);
      expect(after.statusCode).toBe(200);
      expect(after.body).toBe(before.body);
      expect(after.body).not.toContain('data-canvas');
      expect(after.body).not.toContain('__CODEMAN_SHELL__');
    });

    it('keeps the session page free of shell facts and of canvas files', async () => {
      settings(COMBOS[3]);
      const r = await get('/session/abc?from=canvas&ws=' + alpha);
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('window.__CODEMAN_SOLO__="abc"');
      expect(r.body).not.toContain('__CODEMAN_SHELL__');
      expect(r.body).not.toMatch(/canvas(-home)?\.js/);
    });

    it('stores the shell switch through the settings route without touching the canvas switch', async () => {
      settings({});
      const put = (payload: unknown) => inject({ method: 'PUT', url: base + '/api/settings', payload });
      expect((await put({ canvasShellEnabled: true })).statusCode).toBe(200);
      const read = () => JSON.parse(readFileSync(dataPath('settings.json'), 'utf8'));
      expect(read()).toEqual({ canvasShellEnabled: true });
      expect((await get('/')).body).not.toContain('data-canvas');
      // A save from a browser that does not know the key (the previous release's page) leaves it stored.
      expect((await put({ canvasEnabled: true })).statusCode).toBe(200);
      expect(read()).toEqual({ canvasShellEnabled: true, canvasEnabled: true });
      expect((await get('/')).body).toContain('data-canvas');
      expect((await put({ canvasShellEnabled: 'yes' })).statusCode).toBe(400);
      // A read never writes.
      const before = readFileSync(dataPath('settings.json'), 'utf8');
      await inject({ method: 'GET', url: base + '/api/settings' });
      await get('/');
      expect(readFileSync(dataPath('settings.json'), 'utf8')).toBe(before);
    });
  });
}
