/**
 * Stored prototypes over HTTP: publish and the one canvas operation it writes, the address guard, the
 * frame capability and the path the files are served on, and what ends that serving.
 */
import Fastify from 'fastify';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasStores } from '../../src/canvas/canvas-store.js';
import { prototypeFrames } from '../../src/canvas/prototype-frames.js';
import { ViewRegistry } from '../../src/canvas/view-registry.js';
import { workspaceForCase } from '../../src/canvas/workspace-registry.js';
import { PROTOTYPE_MAX_FILE_BYTES, PROTOTYPE_PUBLISHES_PER_MINUTE } from '../../src/config/canvas-limits.js';
import { deployRole } from '../../src/deploy-role.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerCanvasRoutes } from '../../src/web/routes/canvas-routes.js';
import { create } from '../canvas-fixtures.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-prototype-routes-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
  vi.stubEnv('CODEMAN_MULTIUSER', '1');
});
afterEach(() => {
  deployRole.enter('live');
  prototypeFrames.retire(() => true);
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const VIEW = {
  viewport: { x: 0, y: 0, zoom: 1 },
  selected: [],
  focusId: null,
  rail: [],
  context: [],
  conversationId: null,
  root: null,
  letters: false,
  draftBytes: 0,
  phone: false,
  appliedCommands: [],
};
const b64 = (text: string) => Buffer.from(text).toString('base64');
const page = (text: string) => [
  { path: 'index.html', base64: b64(`<!doctype html><title>t</title><h1>${text}</h1><script src="app.js"></script>`) },
  { path: 'app.js', base64: b64(`document.title = ${JSON.stringify(text)};`) },
];

async function setup(name: string, username = 'user-a') {
  const workspace = workspaceForCase(name, 'user-a');
  let clock = 1_000_000;
  const views = new ViewRegistry(() => clock);
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.authUser = { username, role: 'user' };
  });
  const stores = new CanvasStores();
  const port = {
    sessions: new Map(),
    canvasEnabled: async () => true,
    canvasStores: vi.fn(async () => stores),
    broadcast: vi.fn(),
  };
  registerCanvasRoutes(app, port, views);
  installRouteErrorHandler(app);
  await app.ready();
  const base = `/api/canvas/${workspace.id}`;
  const store = stores.get(workspace.id);
  const publish = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `${base}/prototypes`, payload });
  const command = (tool: string, args: unknown) =>
    app.inject({ method: 'POST', url: `${base}/command`, payload: { tool, arguments: args } });
  const frame = (objectId: string) => app.inject({ method: 'POST', url: `${base}/objects/${objectId}/frame` });
  const open = () => {
    clock += 2_000;
    return views.publish(workspace.id, '11111111-1111-4111-8111-111111111111', 'user-a', VIEW as never);
  };
  return {
    app,
    port,
    base,
    store,
    workspace,
    publish,
    command,
    frame,
    open,
    /** Every view goes stale, as when the last browser tab on the workspace closes. */
    closeAll: () => {
      clock += 10 * 60_000;
    },
  };
}
const urlOf = (h: Awaited<ReturnType<typeof setup>>, id: string) => h.store.read().objects[id].content.url as string;

describe('publishing a prototype', () => {
  it('stores a version and writes one embed, then points that embed at the next version', async () => {
    const h = await setup('publish');
    try {
      const first = await h.publish({ name: 'Checkout Flow', files: page('one') });
      expect(first.statusCode, first.body).toBe(200);
      const made = first.json().data;
      expect(made).toMatchObject({
        prototypeId: 'checkout-flow',
        version: 1,
        url: 'https://prototype.invalid/checkout-flow/1/index.html',
      });
      expect(made.sequences).toHaveLength(1);
      const object = h.store.read().objects[made.objectId];
      expect(object).toMatchObject({
        type: 'embed',
        size: { width: 960, height: 640 },
        content: { url: made.url, label: 'Checkout Flow' },
      });
      expect(h.store.operations()).toHaveLength(1);
      expect(h.port.broadcast).toHaveBeenCalledTimes(1);

      const second = await h.publish({ id: 'checkout-flow', files: page('two') });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().data).toMatchObject({ version: 2, objectId: made.objectId });
      expect(urlOf(h, made.objectId)).toBe('https://prototype.invalid/checkout-flow/2/index.html');
      expect(Object.keys(h.store.read().objects)).toEqual([made.objectId]);
      expect(h.store.operations()).toHaveLength(2);

      const listed = (await h.app.inject({ method: 'GET', url: `${h.base}/prototypes` })).json().data.prototypes;
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: 'checkout-flow',
        latest: 2,
        objects: [{ objectId: made.objectId, version: 2 }],
      });
      expect(listed[0].versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
      const one = await h.app.inject({ method: 'GET', url: `${h.base}/prototypes/checkout-flow` });
      expect(one.json().data.latest).toBe(2);
      expect((await h.app.inject({ method: 'GET', url: `${h.base}/prototypes/nope` })).statusCode).toBe(404);
    } finally {
      await h.app.close();
    }
  });

  it('answers a retried publish from the first one, and refuses the same identity with other files', async () => {
    const h = await setup('retry');
    try {
      const payload = { requestId: crypto.randomUUID(), id: 'demo', files: page('one') };
      const first = await h.publish(payload);
      expect(first.statusCode, first.body).toBe(200);
      const log = h.store.operations();
      const again = await h.publish(payload);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().data).toMatchObject({
        replayed: true,
        version: 1,
        objectId: first.json().data.objectId,
        sequences: first.json().data.sequences,
      });
      expect(h.store.operations()).toEqual(log);
      const stored = (await h.app.inject({ method: 'GET', url: `${h.base}/prototypes/demo` })).json().data;
      expect(stored.versions).toHaveLength(1);
      const other = await h.publish({ ...payload, files: page('changed') });
      expect(other.statusCode).toBe(409);
      expect(h.store.operations()).toEqual(log);
    } finally {
      await h.app.close();
    }
  });

  it('says which embed when several show one prototype, and updates the one that is named', async () => {
    const h = await setup('several');
    try {
      const first = (await h.publish({ id: 'demo', files: page('one') })).json().data;
      const copy = await h.command('canvas_create', {
        operations: [
          {
            kind: 'create',
            opId: 'copy',
            objectId: 'copy',
            patch: {
              parentId: null,
              order: 5,
              position: { x: 2000, y: 0 },
              size: { width: 480, height: 320 },
              content: { type: 'embed', url: first.url },
            },
          },
        ],
      });
      expect(copy.statusCode, copy.body).toBe(200);
      const ambiguous = await h.publish({ id: 'demo', files: page('two') });
      expect(ambiguous.statusCode).toBe(409);
      expect(ambiguous.json().error).toContain('objectId');
      const named = await h.publish({ objectId: 'copy', files: page('two') });
      expect(named.statusCode, named.body).toBe(200);
      expect(named.json().data).toMatchObject({ prototypeId: 'demo', version: 2, objectId: 'copy' });
      expect(urlOf(h, first.objectId)).toBe(first.url);
      const notEmbed = await h.publish({ objectId: 'missing', files: page('x') });
      expect(notEmbed.statusCode).toBe(409);
    } finally {
      await h.app.close();
    }
  });

  it('stores nothing for a publish it refuses', async () => {
    const h = await setup('refused');
    try {
      const refused = async (payload: Record<string, unknown>) => {
        const response = await h.publish(payload);
        return [response.statusCode, response.json().refusal];
      };
      expect(await refused({ id: 'demo', files: [{ path: 'app.js', base64: b64('1') }] })).toEqual([400, 'entry']);
      expect(await refused({ id: 'demo', files: [...page('x'), { path: '.env', base64: b64('S') }] })).toEqual([
        400,
        'path',
      ]);
      expect(await refused({ id: 'demo', files: [...page('x'), { path: '../x.js', base64: b64('S') }] })).toEqual([
        400,
        'path',
      ]);
      expect(await refused({ id: 'demo', files: [...page('x'), { path: 'run.sh', base64: b64('S') }] })).toEqual([
        400,
        'type',
      ]);
      const big = Buffer.alloc(PROTOTYPE_MAX_FILE_BYTES + 1, 0x61).toString('base64');
      expect(await refused({ id: 'demo', files: [...page('x'), { path: 'big.js', base64: big }] })).toEqual([
        413,
        'size',
      ]);
      expect((await h.publish({ id: 'Bad Id', files: page('x') })).statusCode).toBe(400);
      expect((await h.publish({ id: 'demo', files: [{ path: 'index.html', base64: '***' }] })).statusCode).toBe(400);
      expect((await h.publish({ id: 'demo', files: page('x'), parentId: 'no-such-parent' })).statusCode).toBe(409);
      expect((await h.publish({ id: 'demo', files: page('x'), extra: 1 })).statusCode).toBe(400);
      expect(existsSync(join(dir, 'canvas', h.workspace.id, 'prototypes'))).toBe(false);
      expect(h.store.operations()).toHaveLength(0);
      deployRole.enter('retired');
      expect((await h.publish({ id: 'demo', files: page('x') })).statusCode).toBe(409);
      expect((await h.app.inject({ method: 'DELETE', url: `${h.base}/prototypes/demo` })).statusCode).toBe(409);
      expect(existsSync(join(dir, 'canvas', h.workspace.id, 'prototypes'))).toBe(false);
    } finally {
      await h.app.close();
    }
  });

  it('limits how often one caller publishes into one workspace', async () => {
    const h = await setup('rate');
    try {
      const codes: number[] = [];
      for (let i = 0; i <= PROTOTYPE_PUBLISHES_PER_MINUTE; i++)
        codes.push((await h.publish({ id: 'demo', files: [{ path: 'app.js', base64: b64('1') }] })).statusCode);
      expect(codes.slice(0, -1).every((code) => code === 400)).toBe(true);
      expect(codes.at(-1)).toBe(429);
    } finally {
      await h.app.close();
    }
  });
});

describe('the prototype address on an embed', () => {
  const embed = (objectId: string, url: string) => ({
    kind: 'create',
    opId: objectId,
    objectId,
    patch: {
      parentId: null,
      order: 9,
      position: { x: 3000, y: 0 },
      size: { width: 480, height: 320 },
      content: { type: 'embed', url },
    },
  });

  it('is accepted only for a version this workspace stores, and never as a link', async () => {
    const h = await setup('address');
    const other = workspaceForCase('address-other', 'user-a');
    try {
      const made = (await h.publish({ id: 'demo', files: page('one') })).json().data;
      const before = h.store.operations().length;
      for (const url of [
        'https://prototype.invalid/demo/2/index.html',
        'https://prototype.invalid/other/1/index.html',
        'https://prototype.invalid/demo/1/missing.html',
        'https://prototype.invalid/demo/1/app.js',
        'https://prototype.invalid/demo/latest/index.html',
        'https://prototype.invalid/',
        'https://prototype.invalid/demo/1/index.html?x=1',
      ]) {
        const response = await h.command('canvas_create', { operations: [embed('e', url)] });
        expect(response.statusCode, url).toBe(409);
      }
      const asLink = await h.command('canvas_update', {
        operations: [
          {
            kind: 'update',
            opId: 'to-link',
            objectId: made.objectId,
            patch: { content: { type: 'link', url: made.url, label: '' } },
          },
        ],
      });
      expect(asLink.statusCode).toBe(409);
      expect(JSON.stringify(asLink.json())).toContain('only be shown as an embed');
      expect(h.store.operations()).toHaveLength(before);
      const good = await h.command('canvas_create', { operations: [embed('e', made.url)] });
      expect(good.statusCode, good.body).toBe(200);
      // Another workspace stores no such version, so the same address is refused there.
      const elsewhere = await h.app.inject({
        method: 'POST',
        url: `/api/canvas/${other.id}/command`,
        payload: { tool: 'canvas_create', arguments: { operations: [embed('e', made.url)] } },
      });
      expect(elsewhere.statusCode).toBe(409);
    } finally {
      await h.app.close();
    }
  });

  it('returns to the earlier version on undo, and that version still serves', async () => {
    const h = await setup('undo');
    try {
      const first = (await h.publish({ id: 'demo', files: page('one') })).json().data;
      const second = (await h.publish({ id: 'demo', files: page('two') })).json().data;
      h.open();
      const undone = await h.command('canvas_history', { action: 'undo', sequences: second.sequences });
      expect(undone.statusCode, undone.body).toBe(200);
      expect(urlOf(h, first.objectId)).toBe(first.url);
      const frame = await h.frame(first.objectId);
      expect(frame.statusCode, frame.body).toBe(200);
      expect(frame.json().data.prototype).toEqual({ id: 'demo', version: 1 });
      const body = await h.app.inject({ method: 'GET', url: frame.json().data.embedUrl });
      expect(body.statusCode).toBe(200);
      expect(body.body).toContain('<h1>one</h1>');
      const redone = await h.command('canvas_history', { action: 'redo', sequences: undone.json().data.sequences });
      expect(redone.statusCode, redone.body).toBe(200);
      expect(urlOf(h, first.objectId)).toBe(second.url);
    } finally {
      await h.app.close();
    }
  });
});

describe('serving a prototype', () => {
  it('mints a frame only while the workspace is open, and serves that one version sandboxed', async () => {
    const h = await setup('serve');
    try {
      const made = (await h.publish({ id: 'demo', files: page('one') })).json().data;
      const closed = await h.frame(made.objectId);
      expect(closed.statusCode).toBe(409);
      expect(closed.json().error).toContain('open in a browser');
      expect(prototypeFrames.size).toBe(0);
      h.open();
      const frame = await h.frame(made.objectId);
      expect(frame.statusCode, frame.body).toBe(200);
      const { embedUrl } = frame.json().data;
      expect(embedUrl).toMatch(/^\/canvas-prototype\/[A-Za-z0-9_-]{32}\/index\.html$/);
      expect((await h.frame(made.objectId)).json().data.embedUrl).toBe(embedUrl);
      const root = embedUrl.slice(0, embedUrl.lastIndexOf('/'));

      const html = await h.app.inject({ method: 'GET', url: embedUrl });
      expect(html.statusCode).toBe(200);
      expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
      const csp = String(html.headers['content-security-policy']);
      expect(csp.startsWith('sandbox ')).toBe(true);
      expect(csp).toContain('allow-scripts');
      expect(csp).not.toContain('allow-same-origin');
      expect(csp).not.toMatch(/default-src|connect-src|script-src/);
      expect(html.headers['x-content-type-options']).toBe('nosniff');
      expect(html.headers['referrer-policy']).toBe('no-referrer');
      expect(html.headers['cache-control']).toBe('no-store');
      expect(html.body).toContain('<h1>one</h1>');

      const script = await h.app.inject({ method: 'GET', url: `${root}/app.js` });
      expect(script.statusCode).toBe(200);
      expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(script.headers['cache-control']).toBe('private, max-age=31536000, immutable');
      expect(script.headers['access-control-allow-origin']).toBe('*');
      expect(String(script.headers['content-security-policy'])).toContain('sandbox');
      expect(script.body).toBe('document.title = "one";');
      const ranged = await h.app.inject({ method: 'GET', url: `${root}/app.js`, headers: { range: 'bytes=0-7' } });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.body).toBe('document');

      for (const path of ['', 'missing.js', '..%2fmeta.json', '.hidden.js', 'sub%2f..%2f..%2fmeta.json']) {
        const response = await h.app.inject({ method: 'GET', url: `${root}/${path}` });
        expect(response.statusCode, path).toBe(404);
        expect(String(response.headers['content-security-policy']), path).toContain('sandbox');
      }
      // Dot segments the URL parser resolves never reach this version's folder at all.
      for (const path of ['%2e%2e/meta.json', '../2/index.html', 'sub/../../meta.json'])
        expect((await h.app.inject({ method: 'GET', url: `${root}/${path}` })).statusCode, path).toBe(404);
      const guessed = await h.app.inject({ method: 'GET', url: `/canvas-prototype/${'a'.repeat(32)}/index.html` });
      expect(guessed.statusCode).toBe(404);
      const post = await h.app.inject({ method: 'POST', url: embedUrl });
      expect(post.statusCode).toBe(404);
    } finally {
      await h.app.close();
    }
  });

  it('stops serving once no view of the workspace is open, and the old link stays dead', async () => {
    const h = await setup('closed');
    try {
      const made = (await h.publish({ id: 'demo', files: page('one') })).json().data;
      h.open();
      const { embedUrl } = (await h.frame(made.objectId)).json().data;
      expect((await h.app.inject({ method: 'GET', url: embedUrl })).statusCode).toBe(200);
      h.closeAll();
      const paused = await h.app.inject({ method: 'GET', url: embedUrl });
      expect(paused.statusCode).toBe(409);
      expect(paused.body).toContain('only while its canvas workspace is open');
      expect(paused.body).not.toContain('<h1>one</h1>');
      expect(String(paused.headers['content-security-policy'])).toContain('sandbox');
      expect((await h.frame(made.objectId)).statusCode).toBe(409);
      // Reopening the workspace does not revive the old link: the browser asks for a new one.
      h.open();
      expect((await h.app.inject({ method: 'GET', url: embedUrl })).statusCode).toBe(404);
      const fresh = (await h.frame(made.objectId)).json().data.embedUrl;
      expect(fresh).not.toBe(embedUrl);
      expect((await h.app.inject({ method: 'GET', url: fresh })).statusCode).toBe(200);
    } finally {
      await h.app.close();
    }
  });

  it('counts only views the caller may see when it mints a frame', async () => {
    const owner = await setup('foreign-view');
    try {
      const made = (await owner.publish({ id: 'demo', files: page('one') })).json().data;
      owner.open();
      expect((await owner.frame(made.objectId)).statusCode).toBe(200);
    } finally {
      await owner.app.close();
    }
    const stranger = await setup('foreign-view', 'user-b');
    try {
      stranger.open();
      const list = await stranger.app.inject({ method: 'GET', url: `${stranger.base}/prototypes` });
      expect(list.statusCode).toBe(404);
    } finally {
      await stranger.app.close();
    }
  });

  it('retires the link when the embed moves to a new version, is deleted, or its owner logs out', async () => {
    const h = await setup('retire');
    try {
      const made = (await h.publish({ id: 'demo', files: page('one') })).json().data;
      h.open();
      const first = (await h.frame(made.objectId)).json().data.embedUrl;
      await h.publish({ id: 'demo', files: page('two') });
      expect((await h.app.inject({ method: 'GET', url: first })).statusCode).toBe(404);
      const second = (await h.frame(made.objectId)).json().data.embedUrl;
      expect((await h.app.inject({ method: 'GET', url: second })).body).toContain('<h1>two</h1>');
      await h.command('canvas_delete', { operations: [{ kind: 'delete', opId: 'del', objectId: made.objectId }] });
      expect((await h.app.inject({ method: 'GET', url: second })).statusCode).toBe(404);
      expect((await h.frame(made.objectId)).statusCode).toBe(409);
      await h.command('canvas_history', { action: 'undo', sequences: [h.store.read().seq] });
      const third = (await h.frame(made.objectId)).json().data.embedUrl;
      expect((await h.app.inject({ method: 'GET', url: third })).statusCode).toBe(200);
      prototypeFrames.revokeOwner('user-a');
      expect((await h.app.inject({ method: 'GET', url: third })).statusCode).toBe(404);
    } finally {
      await h.app.close();
    }
  });

  it('removes a prototype only when no live embed shows it, and then nothing of it is served', async () => {
    const h = await setup('remove');
    try {
      const made = (await h.publish({ id: 'demo', files: page('one') })).json().data;
      h.open();
      const { embedUrl } = (await h.frame(made.objectId)).json().data;
      const held = await h.app.inject({ method: 'DELETE', url: `${h.base}/prototypes/demo` });
      expect(held.statusCode).toBe(409);
      expect(held.json().objects).toEqual([made.objectId]);
      expect((await h.app.inject({ method: 'GET', url: embedUrl })).statusCode).toBe(200);
      await h.command('canvas_delete', { operations: [{ kind: 'delete', opId: 'del', objectId: made.objectId }] });
      const removed = await h.app.inject({ method: 'DELETE', url: `${h.base}/prototypes/demo` });
      expect(removed.statusCode, removed.body).toBe(200);
      expect(existsSync(join(dir, 'canvas', h.workspace.id, 'prototypes', 'demo'))).toBe(false);
      expect((await h.app.inject({ method: 'DELETE', url: `${h.base}/prototypes/demo` })).statusCode).toBe(404);
      // Restoring the deleted embed brings back an object whose version is gone: it says so.
      await h.command('canvas_history', { action: 'undo', sequences: [h.store.read().seq] });
      const gone = await h.frame(made.objectId);
      expect([404, 409]).toContain(gone.statusCode);
    } finally {
      await h.app.close();
    }
  });
});
