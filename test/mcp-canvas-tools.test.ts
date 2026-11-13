import Fastify from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolRunner, createMcpServer, buildToolDefinitions } from '../src/mcp-server.js';
import { toolSchemas, canvasToolNames } from '../src/canvas/commands.js';
import { MAX_CANVAS_TEXT_BYTES } from '../src/canvas/queries.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { registerCanvasRoutes } from '../src/web/routes/canvas-routes.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { create, human } from './canvas-fixtures.js';
import { png as pngImage } from './canvas-media-fixtures.js';
import { deployRole } from '../src/deploy-role.js';
import type { AgentContext, ApiRequest } from '../src/cli-agent.js';
import {
  SCREENSHOT_MISCONFIGURED_MESSAGE,
  type HeadlessBrowser,
  type HeadlessPage,
} from '../src/canvas/canvas-screenshot.js';

const { launchHeadlessBrowser } = vi.hoisted(() => ({ launchHeadlessBrowser: vi.fn() }));
vi.mock('../src/headless-browser.js', () => ({ launchHeadlessBrowser }));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-canvas-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
  vi.stubEnv('CODEMAN_MULTIUSER', '0');
  launchHeadlessBrowser.mockReset();
});
afterEach(() => {
  deployRole.enter('live');
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
async function harness() {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.authUser = { username: 'user-a', role: 'user' };
  });
  const workspace = workspaceForCase('design');
  const other = workspaceForCase('other');
  const stores = new CanvasStores();
  stores
    .get(workspace.id)
    .append([create('section', null, 'section'), create('a', 'section'), create('b', 'section')], human);
  stores.get(other.id).append([create('secret')], human);
  const sessions = new Map([
    ['agent-a', { id: 'agent-a', workingDir: join(resolveCasesDir(), 'design') }],
    ['agent-b', { id: 'agent-b', workingDir: join(resolveCasesDir(), 'other') }],
    ['outside', { id: 'outside', workingDir: dir }],
  ]);
  let enabled = true;
  const port = { sessions, canvasEnabled: async () => enabled, canvasStores: async () => stores, broadcast: vi.fn() };
  registerCanvasRoutes(app, port);
  await app.ready();
  const request: ApiRequest = async (ctx, options) => {
    const url = new URL(options.path.replace('/api/v1/', '/api/'), 'http://codeman.local');
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await app.inject({
      method: options.method,
      url: `${url.pathname}${url.search}`,
      headers: {
        'x-codeman-parent-session': ctx.selfId,
        ...(options.rawBody ? { 'content-type': options.rawBody.contentType } : {}),
      },
      payload: options.rawBody?.data ?? options.body,
    });
    const contentType = String(response.headers['content-type'] ?? '');
    if (contentType.startsWith('image/')) {
      return {
        status: response.statusCode,
        text: '',
        body: response.rawPayload,
        headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, String(value)])),
      };
    }
    return { status: response.statusCode, json: response.json(), text: response.body };
  };
  function runner(selfId = 'agent-a', configured = true) {
    return createToolRunner({
      config: {
        apiUrl: configured ? 'http://example.invalid' : undefined,
        selfId,
        allowAnySession: false,
        version: 'test',
      },
      request,
      started: new Set(),
      clientId: 'test',
    });
  }
  return {
    app,
    workspace,
    other,
    stores,
    request,
    runner,
    broadcast: port.broadcast,
    disable: () => {
      enabled = false;
    },
  };
}
const parse = (result: { text: string }) => JSON.parse(result.text);
describe('canvas MCP HTTP parity', () => {
  it('lists seventeen strict command tools on both protocol eras, including when unconfigured', async () => {
    expect(canvasToolNames).toHaveLength(17);
    for (const name of canvasToolNames) {
      const def = buildToolDefinitions(['claude']).find((t) => t.name === name)!;
      expect(def.description).toContain('untrusted data');
      expect(
        toolSchemas[name].safeParse({ workspaceId: 'other', author: { kind: 'agent', sessionId: 'forged' } }).success
      ).toBe(false);
    }
    const out: Record<string, unknown>[] = [];
    const server = createMcpServer({ config: { allowAnySession: false, version: 'test' }, write: (m) => out.push(m) });
    await server.handleLine(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    );
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect(JSON.stringify(out[1])).toContain('canvas_read');
    for (const name of canvasToolNames) {
      await server.handleLine(
        JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: {} } })
      );
      expect(JSON.stringify(out.at(-1))).toContain('CODEMAN_API_URL');
    }
    server.close();
  });
  it('publishes executable strict JSON schemas for typed union tools', async () => {
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false, useDefaults: false } } });
    const definitions = buildToolDefinitions(['claude']);
    const examples = [
      ['canvas_query', { shape: 'point', point: { x: 0, y: 0 } }],
      ['canvas_arrange', { action: 'ungroup', targetIds: ['g'] }],
      ['canvas_history', { action: 'read' }],
    ] as const;
    for (const [name] of examples) {
      const schema = structuredClone(definitions.find((d) => d.name === name)!.inputSchema);
      delete schema.$schema;
      app.post('/' + name, { schema: { body: schema } }, async () => ({ ok: true }));
    }
    await app.ready();
    try {
      for (const [name, args] of examples) {
        const valid = await app.inject({ method: 'POST', url: '/' + name, payload: args });
        expect(valid.statusCode, name + ': ' + valid.body).toBe(200);
        expect(
          (await app.inject({ method: 'POST', url: '/' + name, payload: { ...args, workspaceId: 'forged' } }))
            .statusCode
        ).toBe(400);
        expect((await app.inject({ method: 'POST', url: '/' + name, payload: {} })).statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });
  it('creates, reads nesting and URLs, searches container paths, updates and soft-deletes with trusted authors', async () => {
    const h = await harness();
    try {
      const tools = h.runner();
      const command = {
        ...create('link', 'section'),
        patch: {
          parentId: 'section',
          order: 1,
          position: { x: 0, y: 0 },
          content: { type: 'link', url: 'https://example.com/design', label: 'Design source' },
        },
      };
      const frame = {
        kind: 'create',
        opId: 'create-frame',
        objectId: 'frame',
        patch: { parentId: 'section', order: 2, position: { x: 0, y: 0 }, content: { type: 'frame', label: 'Images' } },
      };
      const images = ['image-1', 'image-2'].map((id) => ({
        kind: 'create',
        opId: 'create-' + id,
        objectId: id,
        patch: {
          parentId: 'frame',
          order: 0,
          position: { x: 0, y: 0 },
          content: { type: 'image', url: 'https://example.com/' + id, alt: id },
        },
      }));
      expect((await tools.run('canvas_create', { operations: [command, frame, ...images] })).isError).toBe(false);
      const tree = parse(await tools.run('canvas_read', { root: 'section' }));
      expect(tree.tree[0].children.map((n: { object: { id: string } }) => n.object.id)).toContain('link');
      expect(JSON.stringify(tree)).toContain('https://example.com/design');
      expect(
        tree.tree[0].children.find((n: { object: { id: string } }) => n.object.id === 'frame').children
      ).toHaveLength(2);
      const found = parse(await tools.run('canvas_search', { text: 'source' }));
      expect(found.data[0].path.map((p: { id: string }) => p.id)).toEqual(['section', 'link']);
      await tools.run('canvas_update', {
        operations: [
          { kind: 'update', opId: 'update-a', objectId: 'a', patch: { content: { type: 'text', text: 'agent edit' } } },
        ],
      });
      const log = h.stores.get(h.workspace.id).operations();
      expect(log[0].author).toEqual(human);
      expect(log.at(-1)?.author).toEqual({ kind: 'agent', sessionId: 'agent-a' });
      await tools.run('canvas_delete', { operations: [{ kind: 'delete', opId: 'delete-link', objectId: 'link' }] });
      expect(h.stores.get(h.workspace.id).read().objects.link.deletedAt).not.toBeNull();
      await tools.run('canvas_update', { operations: [{ kind: 'restore', opId: 'restore-link', objectId: 'link' }] });
      expect(h.stores.get(h.workspace.id).read().objects.link.deletedAt).toBeNull();
    } finally {
      await h.app.close();
    }
  });
  it('resolves separate case sessions, rejects workspace/author injection and explains a session outside a case', async () => {
    const h = await harness();
    try {
      expect((await h.runner('agent-b').run('canvas_read', {})).text).toContain('secret');
      expect((await h.runner().run('canvas_read', {})).text).not.toContain('secret');
      expect((await h.runner('outside').run('canvas_read', {})).text).toContain('outside a registered canvas case');
      const denied = await h.app.inject({
        method: 'POST',
        url: `/api/canvas/${h.other.id}/command`,
        headers: { 'x-codeman-parent-session': 'agent-a' },
        payload: { tool: 'canvas_read', arguments: {} },
      });
      expect(denied.statusCode).toBe(404);
      expect((await h.runner().run('canvas_read', { workspaceId: h.other.id })).isError).toBe(true);
      expect((await h.runner().run('canvas_create', { operations: [create('forged')], author: human })).isError).toBe(
        true
      );
    } finally {
      await h.app.close();
    }
  });
  it('exposes arrangement, transform, lock, spatial query, history and capabilities through the same path', async () => {
    const h = await harness();
    try {
      const t = h.runner();
      const grouped = await t.run('canvas_arrange', {
        action: 'group',
        targetIds: ['a', 'b'],
        groupId: 'g',
        label: 'G',
        parentId: 'section',
      });
      expect(grouped.isError).toBe(false);
      expect(parse(grouped).hierarchy.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'a', parentId: 'g' }),
          expect.objectContaining({ id: 'g', parentId: 'section' }),
        ])
      );
      const tr = await t.run('canvas_transform', {
        targetIds: ['g', 'a'],
        space: 'world',
        anchor: { x: 0, y: 0 },
        translation: { x: 20, y: 0 },
        scale: { width: 1, height: 1 },
        rotation: 0,
      });
      expect(tr.isError).toBe(false);
      expect(
        parse(await t.run('canvas_query', { shape: 'point', point: { x: 40, y: 40 } })).data.length
      ).toBeGreaterThan(0);
      expect((await t.run('canvas_lock', { targetIds: ['g'], mode: 'subtree' })).isError).toBe(false);
      const refused = parse(
        await t.run('canvas_update', {
          operations: [{ kind: 'move', opId: 'blocked', objectId: 'a', patch: { position: { x: 0, y: 0 } } }],
        })
      );
      expect(refused.reasons[0].code).toBe('LOCKED');
      await t.run('canvas_lock', { targetIds: ['g'], mode: 'unlock' });
      const moved = parse(
        await t.run('canvas_update', {
          operations: [{ kind: 'move', opId: 'own-move', objectId: 'a', patch: { position: { x: 60, y: 70 } } }],
        })
      );
      const undone = await t.run('canvas_history', { action: 'undo', sequences: moved.sequences });
      expect(undone.isError).toBe(false);
      expect((await t.run('canvas_history', { action: 'redo', sequences: parse(undone).sequences })).isError).toBe(
        false
      );
      expect(parse(await t.run('canvas_history', { action: 'read' })).data.length).toBeGreaterThan(0);
      const capabilityResult = await t.run('canvas_capabilities', {});
      expect(Buffer.byteLength(capabilityResult.text)).toBeLessThanOrEqual(MAX_CANVAS_TEXT_BYTES);
      expect(parse(capabilityResult).truncated).toBe(false);
      const beforeReload = h.stores.get(h.workspace.id).read();
      h.stores.reload();
      expect(h.stores.get(h.workspace.id).read()).toEqual(beforeReload);
      expect(parse(capabilityResult).reserved).toEqual([]);
      expect(parse(capabilityResult).conversations.map((c: { command: string }) => c.command)).toEqual([
        'canvas.conversation.list',
        'canvas.conversation.read',
        'canvas.conversation.create',
        'canvas.conversation.send',
        'canvas.conversation.model',
      ]);
      expect(parse(capabilityResult).tasks.map((c: { command: string }) => c.command)).toEqual([
        'canvas.task.list',
        'canvas.task.start',
        'canvas.task.cancel',
        'canvas.task.remove',
      ]);
      expect(parse(capabilityResult).tools.some((tool: { name: string }) => tool.name === 'canvas_screenshot')).toBe(
        true
      );
      expect(parse(capabilityResult).future.render).toBeUndefined();
    } finally {
      await h.app.close();
    }
  });
  it('returns unchanged structured validator reasons for agent and human requests', async () => {
    const h = await harness();
    try {
      const args = {
        operations: [{ kind: 'move', opId: 'unknown', objectId: 'missing', patch: { position: { x: 0, y: 0 } } }],
      };
      const agent = parse(await h.runner().run('canvas_update', args));
      const humanResponse = await h.app.inject({
        method: 'POST',
        url: `/api/canvas/${h.workspace.id}/ops`,
        payload: args,
      });
      expect(agent.reasons).toEqual(humanResponse.json().reasons);
      const state = h.stores.get(h.workspace.id).read();
      const stale = parse(
        await h.runner().run('canvas_update', {
          operations: [
            {
              kind: 'move',
              opId: 'stale',
              objectId: 'a',
              expectedRevision: state.objects.a.revision + 1,
              patch: { position: { x: 0, y: 0 } },
            },
          ],
        })
      );
      expect(stale.reasons[0].code).toBe('REVISION');
    } finally {
      await h.app.close();
    }
  });
  it('rejects a locked compound group without creating any part of the batch', async () => {
    const h = await harness();
    try {
      const store = h.stores.get(h.workspace.id);
      store.append([{ kind: 'lock', opId: 'human-lock', objectId: 'a', patch: { mode: 'subtree' } }], human);
      const before = store.read();
      const result = await h.runner().run('canvas_arrange', {
        action: 'group',
        targetIds: ['a', 'b'],
        groupId: 'failed-group',
        label: 'Failed',
        parentId: 'section',
      });
      expect(parse(result).reasons[0].code).toBe('LOCKED');
      expect(store.read()).toEqual(before);
      expect(store.read().objects['failed-group']).toBeUndefined();
      deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
      const refused = await h.runner().run('canvas_create', { operations: [create('candidate-object')] });
      expect(refused.isError).toBe(true);
      expect(store.read()).toEqual(before);
    } finally {
      await h.app.close();
    }
  });
  it('resolves unique prefixes and owner paths without granting cross-owner scope', async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    const app = Fastify();
    let admin = false;
    app.addHook('onRequest', async (req) => {
      req.authUser = { username: 'user-a', role: admin ? 'admin' : 'user' };
    });
    const a = workspaceForCase('design', 'user-a');
    const b = workspaceForCase('design', 'user-b');
    const sessions = new Map([
      [
        'aaaaaaaa-full',
        {
          id: 'aaaaaaaa-full',
          owner: 'user-a',
          workingDir: join(resolveCasesDir({ username: 'user-a', role: 'user' }), 'design'),
        },
      ],
      [
        'bbbbbbbb-full',
        {
          id: 'bbbbbbbb-full',
          owner: 'user-b',
          workingDir: join(resolveCasesDir({ username: 'user-b', role: 'user' }), 'design'),
        },
      ],
    ]);
    const stores = new CanvasStores();
    registerCanvasRoutes(app, {
      sessions,
      canvasEnabled: async () => true,
      canvasStores: async () => stores,
      broadcast: vi.fn(),
    });
    await app.ready();
    const call = (session: string, workspace = 'current') =>
      app.inject({
        method: 'POST',
        url: `/api/canvas/${workspace}/command`,
        headers: { 'x-codeman-parent-session': session },
        payload: { tool: 'canvas_create', arguments: { operations: [create('owned')] } },
      });
    try {
      expect((await call('aaaaaaaa')).statusCode).toBe(200);
      expect(stores.get(a.id).read().objects.owned.author).toEqual({ kind: 'agent', sessionId: 'aaaaaaaa-full' });
      expect((await call('bbbbbbbb')).statusCode).toBe(400);
      admin = true;
      expect((await call('bbbbbbbb')).statusCode).toBe(200);
      expect(stores.get(b.id).read().objects.owned.author).toEqual({ kind: 'agent', sessionId: 'bbbbbbbb-full' });
      expect((await call('aaaaaaaa', b.id)).statusCode).toBe(404);
      sessions.set('aaaaaaaa-other', {
        id: 'aaaaaaaa-other',
        owner: 'user-a',
        workingDir: sessions.get('aaaaaaaa-full')!.workingDir,
      });
      expect((await call('aaaaaaaa')).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('caps reads and search with text only and retains disabled tool discovery', async () => {
    const h = await harness();
    try {
      const store = h.stores.get(h.workspace.id);
      for (let batch = 0; batch < 2; batch++)
        store.append(
          Array.from({ length: 1000 }, (_, i) => create(`many-${batch}-${i}`, 'section')),
          human
        );
      const out: Record<string, unknown>[] = [];
      const server = createMcpServer({
        config: { apiUrl: 'http://example.invalid', selfId: 'agent-a', allowAnySession: false, version: 'test' },
        request: h.request,
        write: (m) => out.push(m),
      });
      await server.handleLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'canvas_read', arguments: { root: 'section' } },
        })
      );
      const result = out[0].result as { content: { text: string }[]; structuredContent?: unknown };
      expect(result.structuredContent).toBeUndefined();
      expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(MAX_CANVAS_TEXT_BYTES);
      expect(JSON.parse(result.content[0].text).truncated).toBe(true);
      expect(parse(await h.runner().run('canvas_search', { text: 'many' })).truncated).toBe(true);
      server.close();
      h.disable();
      for (const name of canvasToolNames) expect((await h.runner().run(name, {})).text).toContain('Canvas is disabled');
      expect((await h.runner().run('canvas_screenshot', { objectId: 'section' })).text).toBe('Canvas is off');
    } finally {
      await h.app.close();
    }
  });
  it('returns a screenshot as image content and keeps it out of the command envelope', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const seen: { path?: string; query?: Record<string, unknown> } = {};
    const request: ApiRequest = async (_ctx, options) => {
      seen.path = options.path;
      seen.query = options.query;
      if (!options.path.endsWith('/screenshot')) throw new Error(`unexpected ${options.path}`);
      return {
        status: 200,
        text: '',
        body: png,
        headers: {
          'content-type': 'image/png',
          'x-canvas-screenshot-meta': JSON.stringify({ scaled: false, scale: 1, width: 8, height: 8 }),
        },
      };
    };
    const out: Record<string, unknown>[] = [];
    const server = createMcpServer({
      config: { apiUrl: 'http://example.invalid', selfId: 'agent-a', allowAnySession: false, version: 'test' },
      request,
      write: (message) => out.push(message),
    });
    await server.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'canvas_screenshot', arguments: { objectId: 'section', theme: 'light' } },
      })
    );
    const result = out[0].result as {
      content: { type: string; text?: string; mimeType?: string; data?: string }[];
      structuredContent?: unknown;
    };
    expect(seen.path).toBe('/api/v1/canvas/current/objects/section/screenshot');
    expect(seen.query).toEqual({ theme: 'light' });
    expect(result.structuredContent).toBeUndefined();
    expect(result.content.map((item) => item.type)).toEqual(['text', 'image']);
    expect(result.content[1].mimeType).toBe('image/png');
    expect(result.content[1].data).toBe(png.toString('base64'));
    expect(result.content[0].text).toContain('"scaled":false');
    const runner = createToolRunner({
      config: { apiUrl: 'http://example.invalid', selfId: 'agent-a', allowAnySession: false, version: 'test' },
      request,
      started: new Set(),
      clientId: 'test',
    });
    expect((await runner.run('canvas_screenshot', { objectId: 'section', workspaceId: 'other' })).text).toContain(
      'Unknown field'
    );
    expect((await runner.run('canvas_screenshot', {})).text).toContain('objectId');
    const unconfigured = createToolRunner({
      config: { allowAnySession: false, version: 'test' },
      request,
      started: new Set(),
      clientId: 'test',
    });
    expect((await unconfigured.run('canvas_screenshot', { objectId: 'section' })).text).toContain('CODEMAN_API_URL');
    server.close();
  });

  it('returns image content through the real routes when the session header supplies the workspace', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    launchHeadlessBrowser.mockImplementation(async () => shotBrowser(png));
    const h = await harness();
    const ctx: AgentContext = { apiUrl: 'http://example.invalid', selfId: 'agent-a' };
    try {
      const out: Record<string, unknown>[] = [];
      const server = createMcpServer({
        config: { apiUrl: 'http://example.invalid', selfId: 'agent-a', allowAnySession: false, version: 'test' },
        request: h.request,
        write: (message) => out.push(message),
      });
      await server.handleLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'canvas_screenshot', arguments: { objectId: 'section', theme: 'light' } },
        })
      );
      const result = out[0].result as {
        content: { type: string; text?: string; data?: string }[];
        structuredContent?: unknown;
        isError?: boolean;
      };
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content.find((item) => item.type === 'image')?.data).toBe(png.toString('base64'));
      expect(JSON.stringify(out[0])).not.toContain(dir);

      const explicit = await h.request(ctx, {
        method: 'GET',
        path: `/api/v1/canvas/${h.workspace.id}/objects/a/screenshot`,
      });
      expect(explicit.status).toBe(200);
      expect(explicit.body?.subarray(0, 8).equals(png.subarray(0, 8))).toBe(true);

      const rooted = await h.request(ctx, {
        method: 'GET',
        path: '/api/v1/canvas/current/objects',
        query: { root: 'a' },
      });
      expect(rooted.status).toBe(200);
      const objects = (rooted.json as { data: { objects: { id: string }[] } }).data.objects;
      expect(objects.map((object) => object.id)).toEqual(['a']);

      const history = await h.runner().run('canvas_history', { action: 'read', since: 100 });
      expect(history.isError).toBe(false);
      expect(JSON.parse(history.text).data).toEqual([]);
      const ops = await h.request(ctx, {
        method: 'GET',
        path: '/api/v1/canvas/current/ops',
        query: { since: '100' },
      });
      expect(ops.status).toBe(200);
      expect((ops.json as { data: { operations: unknown[] } }).data.operations).toEqual([]);
      server.close();
    } finally {
      await h.app.close();
    }
  });

  it('keeps the data directory out of the screenshot tool text', async () => {
    writeFileSync(join(dir, 'mermaid-runtime.json'), '{');
    const actual = await vi.importActual<typeof import('../src/headless-browser.js')>('../src/headless-browser.js');
    launchHeadlessBrowser.mockImplementation((options: { noSandbox?: boolean; timeoutMs?: number }) =>
      actual.launchHeadlessBrowser(options)
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = await harness();
    try {
      const shot = await h.runner().run('canvas_screenshot', { objectId: 'section' });
      expect(shot.isError).toBe(true);
      expect(shot.text).toContain(SCREENSHOT_MISCONFIGURED_MESSAGE);
      expect(shot.text).not.toContain(dir);
      expect(spy.mock.calls.some((call) => call.join(' ').includes(dir))).toBe(true);
    } finally {
      spy.mockRestore();
      await h.app.close();
    }
  });
});

function shotBrowser(png: Buffer): HeadlessBrowser {
  const page: HeadlessPage = {
    async setViewport() {},
    async setCacheEnabled() {},
    async setRequestInterception() {},
    on() {},
    async goto() {},
    async evaluate() {
      return undefined;
    },
    async screenshot() {
      return png;
    },
  };
  return {
    async newPage() {
      return page;
    },
    async close() {},
    process: () => null,
  };
}

describe('canvas media over MCP', () => {
  it('uploads an image by base64 or path, creates an image object from it, and refuses forged bytes', async () => {
    const h = await harness();
    try {
      const bytes = pngImage(5, 3);
      const uploaded = await h.runner().run('canvas_upload_image', { base64: bytes.toString('base64'), type: 'png' });
      expect(uploaded.isError).toBeFalsy();
      const asset = parse(uploaded);
      expect(asset).toMatchObject({ width: 5, height: 3, mime: 'image/png' });
      const file = join(dir, 'shot.png');
      writeFileSync(file, bytes);
      expect(parse(await h.runner().run('canvas_upload_image', { path: file })).assetId).toBe(asset.assetId);
      const created = await h.runner().run('canvas_create', {
        operations: [
          {
            kind: 'create',
            opId: 'img',
            objectId: 'img',
            patch: {
              parentId: null,
              order: 9,
              position: { x: 0, y: 0 },
              size: { width: 50, height: 30 },
              content: { type: 'image', url: '', alt: 'Chart', assetId: asset.assetId },
            },
          },
        ],
      });
      expect(created.isError).toBeFalsy();
      expect(h.stores.get(h.workspace.id).read().objects.img.content).toMatchObject({ assetId: asset.assetId });
      const forged = await h.runner().run('canvas_upload_image', {
        base64: Buffer.from('not a png at all').toString('base64'),
        type: 'png',
      });
      expect(forged.isError).toBe(true);
      expect(forged.text).toContain('not the image type it claims');
      expect((await h.runner().run('canvas_upload_image', {})).text).toContain('exactly one of path or base64');
      const preview = parse(await h.runner().run('canvas_link_preview', { url: 'http://169.254.169.254/' }));
      expect(preview).toMatchObject({ status: 'unavailable' });
    } finally {
      await h.app.close();
    }
  });
  it('steers an open view through canvas_view and canvas_context with the same tools as the browser', async () => {
    const h = await harness();
    const view = '11111111-1111-4111-8111-111111111111';
    const publish = (context: string[] = []) =>
      h.app.inject({
        method: 'PUT',
        url: `/api/canvas/${h.workspace.id}/views/${view}`,
        payload: {
          viewport: { x: 0, y: 0, zoom: 1 },
          selected: [],
          focusId: null,
          rail: [],
          context,
          conversationId: null,
          root: null,
          letters: true,
          draftBytes: 0,
          phone: false,
          appliedCommands: [],
        },
      });
    try {
      const gone = await h.runner().run('canvas_view', { action: 'read', viewId: view });
      expect(gone.isError).toBe(true);
      expect(gone.text).toContain('VIEW_GONE');
      expect((await publish(['section'])).statusCode).toBe(200);
      expect((await publish()).statusCode).toBe(429);
      const listed = parse(await h.runner().run('canvas_view', { action: 'list' }));
      expect(listed.views.map((v: { viewId: string }) => v.viewId)).toEqual([view]);
      const requestId = '44444444-4444-4444-8444-444444444444';
      const select = { action: 'select', viewId: view, targetIds: ['a'], requestId };
      const first = parse(await h.runner().run('canvas_view', select));
      const again = parse(await h.runner().run('canvas_view', select));
      expect(again).toEqual({ commandId: first.commandId, duplicate: true });
      expect(h.broadcast.mock.calls.filter(([name]) => name === 'canvas:viewCommand')).toHaveLength(1);
      expect(h.broadcast).toHaveBeenCalledWith(
        'canvas:viewCommand',
        expect.objectContaining({ viewId: view, command: { action: 'select', targetIds: ['a'] } })
      );
      const unknown = await h.runner().run('canvas_context', { action: 'add', viewId: view, targetIds: ['nope'] });
      expect(unknown.isError).toBe(true);
      const added = await h.runner().run('canvas_context', { action: 'add', viewId: view, targetIds: ['section'] });
      expect(added.isError).toBeFalsy();
      const read = parse(await h.runner().run('canvas_context', { action: 'read', viewId: view }));
      expect(read.references).toEqual([
        expect.objectContaining({
          id: 'section',
          type: 'section',
          descendants: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })],
        }),
      ]);
      // The other workspace's agent cannot see this view.
      expect((await h.runner('agent-b').run('canvas_view', { action: 'read', viewId: view })).isError).toBe(true);
      const hit = (points: { x: number; y: number }[]) =>
        h
          .runner()
          .run('canvas_query', { shape: 'polygon', points, semantics: 'center' })
          .then((r) =>
            parse(r)
              .data.map((o: { id: string }) => o.id)
              .sort()
          );
      expect(
        await hit([
          { x: 0, y: 0 },
          { x: 200, y: 0 },
          { x: 200, y: 200 },
          { x: 0, y: 200 },
        ])
      ).toEqual(['a', 'b', 'section']);
      expect(
        await hit([
          { x: 65, y: 75 },
          { x: 75, y: 75 },
          { x: 75, y: 85 },
          { x: 65, y: 85 },
        ])
      ).toEqual(['a', 'b']);
      expect(h.stores.get(h.workspace.id).read().seq).toBe(3);
    } finally {
      await h.app.close();
    }
  });
});
