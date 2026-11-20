/**
 * @fileoverview Ambient capture, ticket 1: the vendored rasteriser (html-to-image) is pinned,
 * produced by scripts/prepare-capture-assets.mjs for dev and build, hashed by the build,
 * patched to mask password values (I3) and to clone iframes as empty boxes, and loaded by the dashboard; the main terminal's
 * WebGL addon keeps its drawing buffer so the rasteriser can read it.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const MASKED =
  'd(t,HTMLInputElement)&&e.setAttribute("value","password"===t.type?"\\u2022".repeat(t.value.length):t.value)';

describe('capture rasteriser assets', () => {
  it('pins html-to-image exactly, as a build-time dependency', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.devDependencies['html-to-image']).toBe('1.11.11');
    expect(pkg.dependencies['html-to-image']).toBeUndefined();
  });

  it('is prepared by postinstall for dev and by the build for dist, and content-hashed', () => {
    expect(read('scripts/postinstall.js')).toContain("'prepare-capture-assets.mjs'");
    const build = read('scripts/build.mjs');
    expect(build).toContain("'node scripts/prepare-capture-assets.mjs dist/web/public/vendor'");
    const hashable = build.slice(
      build.indexOf('const HASHABLE = ['),
      build.indexOf('];', build.indexOf('const HASHABLE = ['))
    );
    expect(hashable).toContain("'vendor/html-to-image.js'");
  });

  // Invariant I3: NoPasswordLeavesThePage
  it('writes the bundle without source maps, with the password mask patched in exactly once and frames cloned empty', () => {
    const out = mkdtempSync(join(tmpdir(), 'capture-assets-'));
    try {
      execFileSync(process.execPath, [resolve(root, 'scripts/prepare-capture-assets.mjs'), out]);
      const bundle = readFileSync(join(out, 'html-to-image.js'), 'utf8');
      expect(bundle).not.toContain('sourceMappingURL');
      expect(bundle.split(MASKED).length - 1).toBe(1);
      expect(bundle).not.toContain('setAttribute("value",t.value)');
      expect(bundle, 'a same-origin frame is no longer replaced by its body').not.toContain('[2,T(t)]');
      expect(bundle).not.toContain('t.contentDocument.body.childNodes');
      expect(bundle).toContain('"inline"===o&&(o="inline-block")');
      expect(bundle).toContain('.htmlToImage=');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('loads the rasteriser and capture.js on the dashboard, in that order', () => {
    const html = read('src/web/public/index.html');
    const vendor = html.indexOf('<script defer src="vendor/html-to-image.js"></script>');
    const capture = html.indexOf('<script defer src="capture.js"></script>');
    expect(vendor).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(vendor);
  });

  it('builds the main terminal WebGL addon with preserveDrawingBuffer', () => {
    const app = read('src/web/public/app.js');
    expect(app).toContain('new WebglAddon.WebglAddon(true)');
    expect(app).not.toContain('new WebglAddon.WebglAddon()');
  });
});
