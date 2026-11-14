/**
 * The prototype store: what may be published, where it lands, which versions are kept, and what one
 * version will serve. Behaviour through the module's own functions on a temp data directory.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROTOTYPE_MAX_FILES,
  PROTOTYPE_MAX_FILE_BYTES,
  PROTOTYPE_MAX_VERSION_BYTES,
  PROTOTYPE_VERSIONS_KEPT,
  PROTOTYPES_PER_WORKSPACE,
} from '../src/config/canvas-limits.js';
import { deployRole } from '../src/deploy-role.js';
import { HTML_VIEW_CSP } from '../src/web/routes/html-view-routes.js';
import {
  PROTOTYPE_CSP,
  PrototypeRefusedError,
  checkPrototypeFiles,
  discardPrototypeVersion,
  findPrototypeFile,
  listPrototypes,
  prototypeFileRefusal,
  prototypeSlug,
  prototypeVersionStored,
  publishPrototype,
  readPrototype,
  readPrototypeFile,
  removePrototype,
  versionsToDrop,
} from '../src/canvas/prototypes.js';
import { human } from './canvas-fixtures.js';

const WS = 'ws-proto';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-prototypes-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
});
afterEach(() => {
  deployRole.enter('live');
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const file = (path: string, text = path) => ({ path, data: Buffer.from(text) });
const page = (text = '<h1>hi</h1>') => [file('index.html', text), file('assets/app.js', 'console.log(1)')];
const publish = (id: string, files = page(), referenced: ReadonlySet<number> = new Set()) =>
  publishPrototype(WS, { id, name: id, entry: 'index.html', files, author: human }, referenced);
const reason = async (work: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (error) {
    if (error instanceof PrototypeRefusedError) return error.reason;
    throw error;
  }
  return 'accepted';
};
const versionRoot = (id: string, version: number) => join(dir, 'canvas', WS, 'prototypes', id, String(version));

describe('what a prototype may hold', () => {
  it('refuses hidden names, traversal, odd characters and file types outside the list', () => {
    for (const path of [
      '.env',
      'a/.git/config.json',
      '../up.html',
      'a/../../b.js',
      '/abs.html',
      'a b.html',
      'a\\b.js',
      '',
    ])
      expect(prototypeFileRefusal(path, 1)?.reason, path).toBe('path');
    for (const path of ['run.sh', 'data.csv', 'page.php', 'notes.md', 'noextension', 'lib.exe'])
      expect(prototypeFileRefusal(path, 1)?.reason, path).toBe('type');
    for (const path of ['index.html', 'a/b/c.mjs', 'font.woff2', 'clip.webm', 'app.js.map', 'x.wasm', 'Logo.SVG'])
      expect(prototypeFileRefusal(path, 1), path).toBeNull();
  });

  it('bounds one file, one version and the file count, and needs the entry among the files', async () => {
    expect(prototypeFileRefusal('big.js', PROTOTYPE_MAX_FILE_BYTES + 1)?.reason).toBe('size');
    const many = Array.from({ length: PROTOTYPE_MAX_FILES + 1 }, (_, i) => ({ path: `f${i}.js`, bytes: 1 }));
    expect(await reason(() => checkPrototypeFiles(many, 'index.html'))).toBe('count');
    const heavy = Array.from({ length: 4 }, (_, i) => ({ path: `f${i}.js`, bytes: PROTOTYPE_MAX_VERSION_BYTES / 3 }));
    expect(await reason(() => checkPrototypeFiles([...heavy, { path: 'index.html', bytes: 1 }], 'index.html'))).toBe(
      'size'
    );
    expect(await reason(() => checkPrototypeFiles([], 'index.html'))).toBe('empty');
    expect(await reason(() => checkPrototypeFiles([{ path: 'a.html', bytes: 1 }], 'index.html'))).toBe('entry');
    expect(await reason(() => checkPrototypeFiles([{ path: 'a.js', bytes: 1 }], 'a.js'))).toBe('entry');
    expect(
      await reason(() =>
        checkPrototypeFiles(
          [
            { path: 'index.html', bytes: 1 },
            { path: 'Index.html', bytes: 1 },
          ],
          'index.html'
        )
      )
    ).toBe('path');
  });

  it('derives an id from a name', () => {
    expect(prototypeSlug('  Checkout Flow — v2! ')).toBe('checkout-flow-v2');
    expect(prototypeSlug('???')).toBe('prototype');
    expect(prototypeSlug('x'.repeat(80))).toHaveLength(40);
  });

  it('serves under the same sandbox policy as a rendered HTML file', () => {
    expect(PROTOTYPE_CSP).toBe(HTML_VIEW_CSP);
    expect(PROTOTYPE_CSP).not.toContain('allow-same-origin');
  });
});

describe('publishing', () => {
  it('writes each version as its own private folder and never changes an earlier one', async () => {
    const first = await publish('demo', page('<p>one</p>'));
    const second = await publish('demo', page('<p>two</p>'));
    expect([first.version, second.version]).toEqual([1, 2]);
    expect((await readPrototypeFile(WS, 'demo', 1, 'index.html'))?.bytes.toString()).toBe('<p>one</p>');
    expect((await readPrototypeFile(WS, 'demo', 2, 'index.html'))?.bytes.toString()).toBe('<p>two</p>');
    expect(statSync(join(versionRoot('demo', 1), 'index.html')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'canvas', WS, 'prototypes', 'demo', 'meta.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, 'canvas', WS, 'prototypes', 'demo')).sort()).toEqual(['1', '2', 'meta.json']);
    const meta = await readPrototype(WS, 'demo');
    expect(meta).toMatchObject({ id: 'demo', latest: 2, entry: 'index.html', author: human });
    expect(meta?.versions.map((v) => [v.version, v.files])).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(prototypeVersionStored(WS, 'demo', 2, 'index.html')).toBe(true);
    expect(prototypeVersionStored(WS, 'demo', 3, 'index.html')).toBe(false);
    expect(prototypeVersionStored(WS, 'demo', 2, 'other.html')).toBe(false);
    expect(prototypeVersionStored('other-ws', 'demo', 2, 'index.html')).toBe(false);
  });

  it('refuses a bad id, a bad file and a write from a colour that is not live, storing nothing', async () => {
    expect(await reason(publish('Bad_Id'))).toBe('id');
    expect(await reason(publish('../up'))).toBe('id');
    expect(await reason(publish('demo', [file('index.html'), file('.env', 'SECRET')]))).toBe('path');
    expect(await reason(publish('demo', [file('index.html'), file('../../escape.js')]))).toBe('path');
    deployRole.enter('retired');
    await expect(publish('demo')).rejects.toThrow(/live colour/);
    expect(existsSync(join(dir, 'canvas'))).toBe(false);
    expect(existsSync(join(dir, 'escape.js'))).toBe(false);
  });

  it('keeps the newest versions and every version something still points at', async () => {
    expect(versionsToDrop([1, 2, 3, 4], 2, new Set([1]))).toEqual([2]);
    expect(versionsToDrop([1, 2], 10, new Set())).toEqual([]);
    for (let i = 0; i < PROTOTYPE_VERSIONS_KEPT + 3; i++) await publish('demo', page(`<p>${i}</p>`), new Set([2]));
    const kept = (await readPrototype(WS, 'demo'))!.versions.map((v) => v.version);
    expect(kept).toEqual([2, ...Array.from({ length: PROTOTYPE_VERSIONS_KEPT }, (_, i) => i + 4)]);
    expect(existsSync(versionRoot('demo', 1))).toBe(false);
    expect(existsSync(versionRoot('demo', 3))).toBe(false);
    expect((await readPrototypeFile(WS, 'demo', 2, 'index.html'))?.bytes.toString()).toBe('<p>1</p>');
  });

  it('never reuses a version number after a version was taken back', async () => {
    await publish('demo');
    const second = await publish('demo');
    await discardPrototypeVersion(WS, 'demo', second.version);
    expect(prototypeVersionStored(WS, 'demo', 2, 'index.html')).toBe(false);
    expect((await publish('demo')).version).toBe(3);
  });

  it('takes back a first version whole, so a refused first publish leaves no record', async () => {
    const first = await publish('ghost');
    await discardPrototypeVersion(WS, 'ghost', first.version);
    expect(await readPrototype(WS, 'ghost')).toBeNull();
    expect((await listPrototypes(WS)).map((p) => p.id)).not.toContain('ghost');
  });

  it('asks whether a prototype is in use inside the write queue, after a publish ahead of it has finished', async () => {
    let placed = false;
    const publishing = publish('racy').then(() => {
      placed = true;
    });
    const removing = removePrototype(WS, 'racy', () => placed);
    await publishing;
    expect(await removing).toBe('in-use');
    expect(prototypeVersionStored(WS, 'racy', 1, 'index.html')).toBe(true);
    expect(await removePrototype(WS, 'racy', () => false)).toBe(true);
  });

  it('stops at the workspace quota and at the prototype count, and still shows what is stored', async () => {
    vi.stubEnv('CODEMAN_CANVAS_PROTOTYPE_QUOTA_BYTES', '64');
    await publish('small', [file('index.html', 'x'.repeat(40))]);
    expect(await reason(publish('more', [file('index.html', 'x'.repeat(40))]))).toBe('quota');
    expect((await listPrototypes(WS)).map((p) => p.id)).toEqual(['small']);
    vi.stubEnv('CODEMAN_CANVAS_PROTOTYPE_QUOTA_BYTES', '');
    for (let i = 1; i < PROTOTYPES_PER_WORKSPACE; i++) await publish(`p-${i}`, [file('index.html', 'x')]);
    expect(await reason(publish('one-too-many', [file('index.html', 'x')]))).toBe('limit');
    expect((await publish('small', [file('index.html', 'y')])).version).toBe(2);
    expect(await removePrototype(WS, 'p-1')).toBe(true);
    expect((await publish('one-too-many', [file('index.html', 'x')])).version).toBe(1);
  });
});

describe('what one version serves', () => {
  it('serves only regular files of that version, typed by extension', async () => {
    await publish('demo');
    expect(await findPrototypeFile(WS, 'demo', 1, 'assets/app.js')).toMatchObject({
      mime: 'text/javascript; charset=utf-8',
      size: 14,
    });
    for (const path of [
      '',
      'assets',
      'missing.js',
      '../meta.json',
      'assets/../../meta.json',
      '.hidden.js',
      'meta.json',
    ])
      expect(await findPrototypeFile(WS, 'demo', 1, path), path).toBeNull();
    expect(await findPrototypeFile(WS, 'demo', 2, 'index.html')).toBeNull();
    expect(await findPrototypeFile(WS, 'nope', 1, 'index.html')).toBeNull();
    expect(await findPrototypeFile('../..', 'demo', 1, 'index.html')).toBeNull();
  });

  it('does not follow a link planted in a version folder out of it, or onto a hidden or foreign file', async () => {
    await publish('demo');
    await publish('other', [file('index.html', 'other')]);
    const secret = join(dir, 'secret.json');
    writeFileSync(secret, '{"token":1}');
    const root = versionRoot('demo', 1);
    symlinkSync(secret, join(root, 'leak.json'));
    symlinkSync(join(versionRoot('other', 1), 'index.html'), join(root, 'sibling.html'));
    symlinkSync(join(dir, 'canvas', WS, 'prototypes', 'demo', 'meta.json'), join(root, 'meta-link.json'));
    writeFileSync(join(root, '.dot.json'), '{}');
    symlinkSync(join(root, '.dot.json'), join(root, 'dot-link.json'));
    for (const path of ['leak.json', 'sibling.html', 'meta-link.json', 'dot-link.json'])
      expect(await findPrototypeFile(WS, 'demo', 1, path), path).toBeNull();
    expect(await findPrototypeFile(WS, 'demo', 1, 'index.html')).not.toBeNull();
  });
});
