/**
 * Reviewing a prototype from a phone, the parts with no browser: which version a comment was made on, the picture
 * and crop routes (served from what is kept, refused for what is not stored), the crop's geometry, and the pure
 * pieces of the phone card and the review view. Comments still have no resolved state, and an agent's tool cannot
 * give them one. The browser suite (`canvas-prototype-review.browser.test.ts`) draws real pictures.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { registerCanvasRoutes } from '../src/web/routes/canvas-routes.js';
import { commentVersionsPath, readCommentVersions, shownVersion } from '../src/canvas/comment-versions.js';
import { CommentToolSchema } from '../src/canvas/commands.js';
import { FOCUS_MARGIN, FOCUS_MAX_HEIGHT, FOCUS_MIN_WIDTH, focusClip } from '../src/canvas/canvas-screenshot.js';
import {
  DESKTOP_CROP,
  PHONE_PICTURE,
  cropPicturePath,
  cropViewport,
  versionPicturePath,
} from '../src/canvas/prototype-pictures.js';
import { parseVersions } from '../packages/canvas/src/element-anchors.js';
import { locateHint } from '../packages/canvas/src/frame-messages.js';
import { parseVersionInfo } from '../packages/canvas/src/prototype-versions.js';
import { cardLine } from '../packages/canvas/src/prototype-card.js';
import { DESKTOP_WIDTH, reviewLayout, reviewMeta } from '../packages/canvas/src/prototype-review.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-prototype-review-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const element = (objectId: string) => ({
  objectId,
  selector: '#start',
  path: 'main > button#start',
  tag: 'button',
  text: 'Start task',
  rect: { x: 12, y: 80, width: 90, height: 32 },
  attrs: {},
  styles: {},
});

async function server(): Promise<{ app: FastifyInstance; stores: CanvasStores; base: string; workspace: string }> {
  const workspace = workspaceForCase('review').id;
  const stores = new CanvasStores();
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.authUser = { username: 'user-a', role: 'user' };
  });
  registerCanvasRoutes(app, {
    sessions: new Map(),
    canvasEnabled: async () => true,
    canvasStores: async () => stores,
    broadcast: vi.fn(),
  });
  await app.ready();
  return { app, stores, base: `/api/canvas/${workspace}`, workspace };
}
const files = (text: string) => [{ path: 'index.html', base64: Buffer.from(text).toString('base64') }];

describe('the version a comment was made on', () => {
  it('is stamped by the server from the address the embed shows, for comments on a prototype only', async () => {
    const { app, base, workspace, stores } = await server();
    try {
      const first = await app.inject({
        method: 'POST',
        url: `${base}/prototypes`,
        payload: { name: 'Work', files: files('one') },
      });
      expect(first.statusCode, first.body).toBe(200);
      const objectId = first.json().data.objectId as string;
      const comment = (commentId: string, extra: Record<string, unknown> = {}) =>
        app.inject({
          method: 'POST',
          url: `${base}/command`,
          payload: { tool: 'canvas_comment', arguments: { objectId, text: 'Look', commentId, ...extra } },
        });
      const a = crypto.randomUUID(),
        b = crypto.randomUUID(),
        c = crypto.randomUUID();
      expect((await comment(a, { element: element(objectId) })).statusCode).toBe(200);
      expect((await comment(b)).statusCode).toBe(200);
      const second = await app.inject({
        method: 'POST',
        url: `${base}/prototypes`,
        payload: { id: 'work', files: files('two') },
      });
      expect(second.statusCode, second.body).toBe(200);
      expect((await comment(c)).statusCode).toBe(200);
      const read = (await app.inject({ url: `${base}/comment-anchors` })).json().data;
      // A comment keeps the version it was made on when a newer one is published into its embed.
      expect(read.versions).toEqual({ [a]: 1, [b]: 1, [c]: 2 });
      expect(Object.keys(read.anchors)).toEqual([a]);
      expect(shownVersion(stores.get(workspace).read(), objectId)).toBe(2);

      // A comment on anything that is not a stored prototype gets no entry.
      const note = await app.inject({
        method: 'POST',
        url: `${base}/ops`,
        payload: {
          operations: [
            {
              kind: 'create',
              opId: crypto.randomUUID(),
              objectId: crypto.randomUUID(),
              patch: {
                parentId: null,
                order: 9,
                position: { x: 0, y: 0 },
                size: { width: 100, height: 60 },
                content: { type: 'text', text: 'hi' },
              },
            },
          ],
        },
      });
      expect(note.statusCode, note.body).toBe(200);
      const textId = Object.values(stores.get(workspace).read().objects).find((o) => o.type === 'text')!.id;
      const d = crypto.randomUUID();
      const onText = await app.inject({
        method: 'POST',
        url: `${base}/command`,
        payload: { tool: 'canvas_comment', arguments: { objectId: textId, text: 'Note', commentId: d } },
      });
      expect(onText.statusCode).toBe(200);
      expect(readCommentVersions(workspace, stores.get(workspace).read())[d]).toBeUndefined();
      // The side file is the only place it lives: the stored comment carries no new key.
      const stored = stores
        .get(workspace)
        .read()
        .comments.find((x) => x.id === a)!;
      expect(Object.keys(stored).sort()).not.toContain('version');
      const file = JSON.parse(readFileSync(commentVersionsPath(workspace), 'utf8'));
      expect(file.version).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('is never something a caller chooses, and a comment has no resolved state an agent could set', () => {
    const objectId = crypto.randomUUID();
    expect(CommentToolSchema.safeParse({ objectId, text: 'x', version: 3 }).success).toBe(false);
    expect(CommentToolSchema.safeParse({ objectId, text: 'x', resolved: true }).success).toBe(false);
    expect(CommentToolSchema.safeParse({ objectId, text: 'x', status: 'resolved' }).success).toBe(false);
    expect(CommentToolSchema.safeParse({ objectId, text: 'x' }).success).toBe(true);
  });

  it('reads as nothing from a file it does not understand', () => {
    const workspace = workspaceForCase('broken').id;
    mkdirSync(dirname(commentVersionsPath(workspace)), { recursive: true });
    writeFileSync(commentVersionsPath(workspace), '{"version":2,"versions":{}}');
    expect(readCommentVersions(workspace, { comments: [] } as never)).toEqual({});
  });
});

describe('the picture and crop routes', () => {
  it('serve a kept picture, and refuse a version, a theme or a comment they have nothing for', async () => {
    const { app, base, workspace } = await server();
    try {
      const made = await app.inject({
        method: 'POST',
        url: `${base}/prototypes`,
        payload: { name: 'Work', files: files('one') },
      });
      const objectId = made.json().data.objectId as string;
      const path = versionPicturePath(workspace, 'work', 1, 'light')!;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, PNG);
      const kept = await app.inject({ url: `${base}/prototypes/work/versions/1/picture?theme=light` });
      expect(kept.statusCode).toBe(200);
      expect(kept.headers['content-type']).toBe('image/png');
      expect(kept.headers['cache-control']).toBe('private, max-age=31536000, immutable');
      expect(kept.headers['x-content-type-options']).toBe('nosniff');
      expect(kept.rawPayload.equals(PNG)).toBe(true);
      expect((await app.inject({ url: `${base}/prototypes/work/versions/2/picture` })).statusCode).toBe(404);
      expect((await app.inject({ url: `${base}/prototypes/work/versions/0x1/picture` })).statusCode).toBe(404);
      expect((await app.inject({ url: `${base}/prototypes/nope/versions/1/picture` })).statusCode).toBe(404);
      expect((await app.inject({ url: `${base}/prototypes/work/versions/1/picture?theme=sepia` })).statusCode).toBe(
        400
      );

      const plain = crypto.randomUUID(),
        about = crypto.randomUUID();
      for (const [commentId, extra] of [
        [plain, {}],
        [about, { element: element(objectId) }],
      ] as const)
        await app.inject({
          method: 'POST',
          url: `${base}/command`,
          payload: { tool: 'canvas_comment', arguments: { objectId, text: 'Look', commentId, ...extra } },
        });
      expect((await app.inject({ url: `${base}/comments/${plain}/crop` })).statusCode).toBe(404);
      expect((await app.inject({ url: `${base}/comments/not-an-id/crop` })).statusCode).toBe(404);
      const crop = cropPicturePath(workspace, 'work', about, 1, 'dark')!;
      writeFileSync(crop, PNG);
      const served = await app.inject({ url: `${base}/comments/${about}/crop` });
      expect(served.statusCode).toBe(200);
      expect(served.headers['cache-control']).toBe('private, max-age=86400');
      expect(served.rawPayload.equals(PNG)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('names its files only from validated parts', () => {
    expect(versionPicturePath('../ws', 'work', 1, 'dark')).toBeNull();
    const workspace = workspaceForCase('names').id;
    expect(versionPicturePath(workspace, '../work', 1, 'dark')).toBeNull();
    expect(versionPicturePath(workspace, 'work', 0, 'dark')).toBeNull();
    expect(versionPicturePath(workspace, 'work', 1.5, 'dark')).toBeNull();
    expect(cropPicturePath(workspace, 'work', '../x', 1, 'dark')).toBeNull();
    expect(versionPicturePath(workspace, 'work', 3, 'light')).toMatch(/prototypes\/work\/pictures\/v3-light\.png$/);
  });
});

describe('the crop of where an element was', () => {
  it('is drawn at a phone width for an element that fitted one, and at a desktop width otherwise', () => {
    expect(cropViewport({ x: 12, width: 90 })).toEqual(PHONE_PICTURE);
    expect(cropViewport({ x: 400, width: 90 })).toEqual(DESKTOP_CROP);
  });
  it('shows a phone-wide strip round the element, inside the picture and never too tall', () => {
    expect(focusClip({ x: 12, y: 80, width: 90, height: 32 }, 390, 844)).toEqual({
      x: 0,
      y: 80 - FOCUS_MARGIN,
      width: FOCUS_MIN_WIDTH,
      height: 32 + 2 * FOCUS_MARGIN,
    });
    // Centred on an element in the middle of a wide page.
    const wide = focusClip({ x: 600, y: 300, width: 80, height: 20 }, 1280, 800);
    expect(wide.x + wide.width / 2).toBeCloseTo(640, 0);
    expect(wide.width).toBe(FOCUS_MIN_WIDTH);
    // Near the bottom edge it stays inside, and a tall element is cut to the cap.
    const low = focusClip({ x: 10, y: 830, width: 50, height: 10 }, 390, 844);
    expect(low.y + low.height).toBeLessThanOrEqual(844);
    expect(focusClip({ x: 0, y: 0, width: 390, height: 2000 }, 390, 844).height).toBe(Math.min(844, FOCUS_MAX_HEIGHT));
    // An element wider than a phone keeps its margin.
    expect(focusClip({ x: 100, y: 10, width: 900, height: 40 }, 1280, 800).width).toBe(900 + 2 * FOCUS_MARGIN);
  });
});

describe('the client pieces', () => {
  it('reads versions from the anchors answer, ignoring what is not a version', () => {
    const versions = parseVersions({ success: true, data: { anchors: {}, versions: { a: 2, b: 0, c: 'x', d: 1.5 } } });
    expect([...versions]).toEqual([['a', 2]]);
    // The release before this one answers without versions.
    expect(parseVersions({ success: true, data: { anchors: {} } }).size).toBe(0);
    expect(parseVersions(null).size).toBe(0);
  });
  it('reads who published each version, naming an agent the way comments do', () => {
    const info = parseVersionInfo({
      success: true,
      data: {
        prototypes: [
          {
            id: 'work',
            versions: [
              { version: 1, createdAt: 5, author: { kind: 'human', userId: 'harry' } },
              { version: 2, createdAt: 9, author: { kind: 'agent', sessionId: '1a2b3c4d5e6f' } },
            ],
          },
        ],
      },
    });
    expect(info.get('work/1')).toEqual({ createdAt: 5, author: 'harry' });
    expect(info.get('work/2')).toEqual({ createdAt: 9, author: 'Agent 1a2b3c4d' });
    expect(parseVersionInfo({ success: false }).size).toBe(0);
  });
  it("sends the element's tag, text and pick-time position as its hint", () => {
    expect(locateHint(element('o'))).toEqual({ tag: 'button', text: 'Start task', x: 12, y: 80 });
  });
  it('says on the card what is known: who published it, that it is drawing, gone, failed or offline', () => {
    const base = {
      version: 3,
      published: { createdAt: 0, author: 'harry' },
      pictureAt: null,
      now: 10_000,
      online: true,
    };
    expect(cardLine({ ...base, picture: 'ready' })).toBe('Published just now by harry');
    expect(cardLine({ ...base, picture: 'loading' })).toBe('Published just now by harry · drawing a picture');
    expect(cardLine({ ...base, picture: 'loading', published: null })).toBe('Drawing a picture');
    expect(cardLine({ ...base, picture: 'gone' })).toBe('v3 is no longer stored');
    expect(cardLine({ ...base, picture: 'failed' })).toBe('The picture could not be drawn');
    expect(cardLine({ ...base, picture: 'loading', online: false })).toBe('Offline · no picture yet');
    expect(
      cardLine({ ...base, picture: 'ready', online: false, pictureAt: new Date(2026, 10, 15, 9, 5).getTime() })
    ).toBe('Offline · picture from 09:05');
  });
  it('lays the page out at the stage width, or at 1280 px scaled down to fit and as tall as the stage', () => {
    expect(reviewLayout('phone', { width: 390, height: 700 })).toEqual({ width: 390, height: 700, scale: 1 });
    const desktop = reviewLayout('desktop', { width: 390, height: 700 });
    expect(desktop.width).toBe(DESKTOP_WIDTH);
    expect(desktop.scale).toBeCloseTo(390 / 1280);
    expect(desktop.height * desktop.scale).toBeCloseTo(700, 0);
    // A stage wider than the desktop width draws it at full size.
    expect(reviewLayout('desktop', { width: 1600, height: 900 }).scale).toBe(1);
    expect(reviewMeta(2, 'Agent 1a2b3c4d')).toBe('v2 · Agent 1a2b3c4d');
    expect(reviewMeta(2, null)).toBe('v2');
  });
});
