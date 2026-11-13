import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCanvasRoutes } from '../src/web/routes/canvas-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { readConversations } from '../src/canvas/conversations.js';
import { SseEvent } from '../src/web/sse-events.js';
import { deployRole } from '../src/deploy-role.js';

const installed = vi.hoisted(() => ({ map: {} as Record<string, boolean>, claudeDisabled: false }));
vi.mock('../src/utils/cli-installed-probes.js', async (original) => ({
  ...(await original<typeof import('../src/utils/cli-installed-probes.js')>()),
  probeStockCliAvailability: async () => installed.map,
}));

vi.mock('../src/config/cli-registry/registry.js', async (original) => {
  const real = await original<typeof import('../src/config/cli-registry/registry.js')>();
  const { STOCK_CLIS } = await import('../src/config/cli-registry/stock.js');
  const base = STOCK_CLIS.find((e) => (e.id as string) === 'copilot')!;
  const acme = {
    ...base,
    id: 'acme',
    label: 'Acme',
    stock: false,
    order: 9999,
    capabilities: { ...base.capabilities, workDetect: { ...base.capabilities.workDetect, blockedLine: 'Allow\\?' } },
  } as unknown as import('../src/config/cli-registry/types.js').CliEntry;
  return {
    ...real,
    enabledClis: () => [...real.enabledClis(), acme].filter((e) => !(installed.claudeDisabled && e.id === 'claude')),
    getCli: (id: string) => (id === 'acme' ? acme : real.getCli(id)),
  };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-prov-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
  installed.map = { claude: true, copilot: true, codex: false, acme: true };
  installed.claudeDisabled = false;
});
afterEach(() => {
  deployRole.enter('live');
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
const uuid = () => crypto.randomUUID();
type Request = { workingDir: string; name: string; mode: string; launch: Record<string, unknown> };
async function harness(extra: Record<string, unknown> = {}) {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.authUser = { username: 'admin', role: 'admin' };
  });
  const sessions = new Map<string, { id: string; workingDir: string; writeViaMux: ReturnType<typeof vi.fn> }>();
  const started: Request[] = [];
  const broadcast = vi.fn();
  const port = {
    sessions,
    canvasEnabled: async () => true,
    canvasStores: async () => new CanvasStores(),
    broadcast,
    startConversationSession: vi.fn(async (_headers: unknown, request: Request) => {
      started.push(request);
      const id = `session-${sessions.size + 1}`;
      sessions.set(id, { id, workingDir: request.workingDir, writeViaMux: vi.fn(async () => true) });
      return { ok: true as const, sessionId: id };
    }),
    ...extra,
  };
  registerCanvasRoutes(app, port as never);
  installRouteErrorHandler(app);
  await app.ready();
  const workspace = workspaceForCase('prov-case');
  const base = `/api/canvas/${workspace.id}`;
  const post = async (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: payload as never, headers });
  return {
    app,
    started,
    broadcast,
    workspace,
    base,
    create: (payload: Record<string, unknown> = {}) => post(`${base}/conversations`, { requestId: uuid(), ...payload }),
    tool: (args: Record<string, unknown>, headers: Record<string, string> = {}) =>
      post(`${base}/command`, { tool: 'canvas_conversation', arguments: args }, headers),
    publish: async (viewId: string, extra: Record<string, unknown> = {}) =>
      app.inject({
        method: 'PUT',
        url: `${base}/views/${viewId}`,
        payload: {
          viewport: { x: 0, y: 0, zoom: 1 },
          selected: [],
          focusId: null,
          rail: [],
          context: [],
          conversationId: null,
          root: null,
          letters: true,
          draftBytes: 0,
          phone: false,
          appliedCommands: [],
          ...extra,
        },
      }),
  };
}

describe('GET /api/canvas/assistant/providers', () => {
  it('lists the enabled, installed agent CLIs from the registry, each with whether it can start and why not', async () => {
    installed.map = { claude: true, copilot: true, codex: true, acme: true };
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/canvas/assistant/providers' });
      expect(response.statusCode).toBe(200);
      const rows = response.json().data.providers as { id: string; available: boolean; reason?: string }[];
      expect(rows.map((r) => r.id)).toEqual(['claude', 'codex', 'copilot', 'acme']);
      expect(rows.find((r) => r.id === 'claude')).toMatchObject({ available: true });
      const codex = rows.find((r) => r.id === 'codex')!;
      expect(codex.available).toBe(false);
      expect(codex.reason).toMatch(/confirm a message was submitted/);
      const copilot = rows.find((r) => r.id === 'copilot')!;
      expect(copilot.available).toBe(false);
      expect(copilot.reason).toMatch(/cannot tell Codeman when it is waiting for your answer/);
      expect(rows.find((r) => r.id === 'acme')).toMatchObject({ available: true });
    } finally {
      await h.app.close();
    }
  });
  it('leaves out a CLI that is not installed', async () => {
    const h = await harness();
    try {
      const rows = (await h.app.inject({ method: 'GET', url: '/api/canvas/assistant/providers' })).json().data
        .providers as { id: string }[];
      expect(rows.map((r) => r.id)).toEqual(['claude', 'copilot', 'acme']);
    } finally {
      await h.app.close();
    }
  });
});

describe('the voice relay fact on the providers answer', () => {
  const relay = async (extra: Record<string, unknown>) => {
    const h = await harness(extra);
    try {
      return (await h.app.inject({ method: 'GET', url: '/api/canvas/assistant/providers' })).json().data.voice;
    } finally {
      await h.app.close();
    }
  };
  it('is one boolean, true only when the server says the relay would take a stream', async () => {
    expect(await relay({})).toEqual({ relay: false });
    expect(await relay({ voiceRelayAvailable: async () => false })).toEqual({ relay: false });
    expect(await relay({ voiceRelayAvailable: async () => true })).toEqual({ relay: true });
  });
  it('a read that throws is no relay, and the answer is kept briefly instead of read on every request', async () => {
    expect(
      await relay({
        voiceRelayAvailable: async () => {
          throw new Error('unreadable');
        },
      })
    ).toEqual({ relay: false });
    const read = vi.fn(async () => true);
    const h = await harness({ voiceRelayAvailable: read });
    try {
      for (let i = 0; i < 3; i++) {
        const response = await h.app.inject({ method: 'GET', url: '/api/canvas/assistant/providers' });
        expect(response.statusCode).toBe(200);
        expect(response.json().data.voice).toEqual({ relay: true });
      }
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      await h.app.close();
    }
  });
});

describe('starting a conversation on a chosen CLI and model', () => {
  it('passes the model as claude`s per-session field, never modelOverride, and records it', async () => {
    const h = await harness();
    try {
      const response = await h.create({ cliId: 'claude', model: 'opus[1m]' });
      expect(response.statusCode).toBe(200);
      expect(h.started).toHaveLength(1);
      expect(h.started[0]).toMatchObject({ mode: 'claude', launch: { model: 'opus[1m]' } });
      expect(JSON.stringify(h.started[0])).not.toContain('modelOverride');
      const conversation = response.json().data.conversation;
      expect(conversation).toMatchObject({ cliId: 'claude', cliLabel: 'Claude Code', model: 'opus[1m]' });
      const file = readConversations(h.workspace.id);
      expect(file.ok && file.conversations[0]).toMatchObject({ cliId: 'claude', model: 'opus[1m]' });
    } finally {
      await h.app.close();
    }
  });

  it('passes a flag CLI its model inside its own config object', async () => {
    const h = await harness();
    try {
      const response = await h.create({ cliId: 'acme', model: 'gpt-5/mini' });
      expect(response.statusCode).toBe(200);
      expect(h.started[0]).toMatchObject({ mode: 'acme', launch: { copilotConfig: { model: 'gpt-5/mini' } } });
      expect(response.json().data.conversation).toMatchObject({ cliId: 'acme', model: 'gpt-5/mini' });
    } finally {
      await h.app.close();
    }
  });

  it('with no choice it starts exactly what it always did: the default CLI, no launch fields, no model', async () => {
    installed.map = { claude: false };
    const h = await harness();
    try {
      const response = await h.create();
      expect(response.statusCode).toBe(200);
      expect(h.started[0]).toMatchObject({ mode: 'claude', launch: {} });
      expect(response.json().data.conversation.model).toBeUndefined();
    } finally {
      await h.app.close();
    }
  });

  it('refuses a create that names no CLI when the default CLI is disabled in the registry', async () => {
    installed.claudeDisabled = true;
    const h = await harness();
    try {
      const refused = await h.create();
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatch(/^CLI_UNAVAILABLE: /);
      expect((await h.create({ cliId: 'claude' })).statusCode).toBe(400);
      expect(h.started).toHaveLength(0);
    } finally {
      await h.app.close();
    }
  });

  it('keeps a model-less conversation on the CLI default: no launch fields at all', async () => {
    const h = await harness();
    try {
      await h.create({ cliId: 'acme' });
      expect(h.started[0].launch).toEqual({});
    } finally {
      await h.app.close();
    }
  });

  it('refuses an unknown or uninstalled CLI, an unavailable one, and a malformed model, starting nothing', async () => {
    installed.map = { claude: true, copilot: true, codex: true, acme: true };
    const h = await harness();
    try {
      const unknown = await h.create({ cliId: 'nonesuch' });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().error).toMatch(/^UNKNOWN_CLI/);
      const blind = await h.create({ cliId: 'copilot' });
      expect(blind.statusCode).toBe(409);
      expect(blind.json().error).toMatch(/^CLI_UNAVAILABLE: .*waiting for your answer/);
      const unavailable = await h.create({ cliId: 'codex' });
      expect(unavailable.statusCode).toBe(409);
      expect(unavailable.json().error).toMatch(/^CLI_UNAVAILABLE: .*confirm a message was submitted/);
      for (const model of ['--yolo', 'a b', 'a;b', 'x'.repeat(101), 'claude/opus']) {
        const bad = await h.create({ cliId: 'claude', model });
        expect(bad.statusCode, model).toBe(400);
      }
      expect((await h.create({ cliId: 'claude', model: '--yolo' })).json().error).toMatch(/^INVALID_MODEL/);
      installed.map = { claude: false, copilot: true };
      expect((await h.create({ cliId: 'claude' })).statusCode).toBe(400);
      expect(h.started).toHaveLength(0);
    } finally {
      await h.app.close();
    }
  });

  it('answers a retried request id with the first conversation, whatever choice the retry carries', async () => {
    const h = await harness();
    try {
      const requestId = uuid();
      const first = await h.create({ requestId, cliId: 'claude', model: 'opus' });
      const retry = await h.create({ requestId, cliId: 'acme', model: 'x' });
      expect(retry.json().data.duplicate).toBe(true);
      expect(retry.json().data.conversation.id).toBe(first.json().data.conversation.id);
      expect(h.started).toHaveLength(1);
    } finally {
      await h.app.close();
    }
  });

  it('stays human-only: an agent cannot start a conversation on any CLI', async () => {
    const h = await harness();
    try {
      const { conversation } = (await h.create()).json().data;
      const refused = await h.tool(
        { action: 'create', requestId: uuid(), cliId: 'acme' },
        { 'x-codeman-parent-session': conversation.sessionId }
      );
      expect(refused.statusCode).toBe(403);
      expect(h.started).toHaveLength(1);
    } finally {
      await h.app.close();
    }
  });
});

describe('canvas_conversation model', () => {
  it('sets the open view`s choice for its next run through a view command, and starts nothing', async () => {
    const h = await harness();
    try {
      const viewId = uuid();
      expect((await h.publish(viewId)).statusCode).toBe(200);
      const set = await h.tool({ action: 'model', operation: 'set', viewId, cliId: 'acme', model: 'gpt-5' });
      expect(set.statusCode).toBe(200);
      expect(h.broadcast).toHaveBeenCalledWith(
        SseEvent.CanvasViewCommand,
        expect.objectContaining({
          viewId,
          command: { action: 'assistant-choice', cliId: 'acme', model: 'gpt-5' },
        })
      );
      expect(h.started).toHaveLength(0);
    } finally {
      await h.app.close();
    }
  });

  it('reads the choice the view reports, with the providers it can pick from', async () => {
    const h = await harness();
    try {
      const viewId = uuid();
      await h.publish(viewId, { choice: { cliId: 'acme', model: 'gpt-5' } });
      const read = await h.tool({ action: 'model', operation: 'read', viewId });
      expect(read.statusCode).toBe(200);
      expect(read.json().data.choice).toEqual({ cliId: 'acme', model: 'gpt-5' });
      expect((read.json().data.providers as { id: string }[]).map((p) => p.id)).toEqual(['claude', 'copilot', 'acme']);
      const plain = uuid();
      await h.publish(plain);
      expect((await h.tool({ action: 'model', operation: 'read', viewId: plain })).json().data.choice).toEqual({
        cliId: null,
        model: '',
      });
    } finally {
      await h.app.close();
    }
  });

  it('validates the provider and the model strictly, and answers VIEW_GONE for a closed view', async () => {
    installed.map = { claude: true, copilot: true, codex: true, acme: true };
    const h = await harness();
    try {
      const viewId = uuid();
      await h.publish(viewId);
      const set = (extra: Record<string, unknown>) => h.tool({ action: 'model', operation: 'set', viewId, ...extra });
      expect((await set({ model: 'x' })).statusCode).toBe(400);
      expect((await set({ cliId: 'nonesuch' })).statusCode).toBe(400);
      expect((await set({ cliId: 'codex' })).statusCode).toBe(409);
      expect((await set({ cliId: 'claude', model: '--yolo' })).statusCode).toBe(400);
      expect((await set({ cliId: 'claude', model: 'a b' })).statusCode).toBe(400);
      expect(h.broadcast).not.toHaveBeenCalledWith(SseEvent.CanvasViewCommand, expect.anything());
      const gone = await h.tool({ action: 'model', operation: 'set', viewId: uuid(), cliId: 'claude' });
      expect(gone.statusCode).toBe(404);
      expect(gone.json().error).toMatch(/VIEW_GONE/);
      expect((await set({ cliId: 'claude' })).statusCode).toBe(200);
    } finally {
      await h.app.close();
    }
  });
});
