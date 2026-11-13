import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
await build({
  entryPoints: [fileURLToPath(new URL('packages/canvas/src/entry.ts', root))],
  outfile: fileURLToPath(new URL('src/web/public/canvas.js', root)),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
});
// The shell's first-run page (PC13): its own small module, so it starts without the canvas bundle.
await build({
  entryPoints: [fileURLToPath(new URL('packages/canvas/src/home.ts', root))],
  outfile: fileURLToPath(new URL('src/web/public/canvas-home.js', root)),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
});
await build({
  entryPoints: [fileURLToPath(new URL('packages/canvas/src/shot.ts', root))],
  outfile: fileURLToPath(new URL('src/web/public/canvas-shot.js', root)),
  bundle: true,
  format: 'iife',
  globalName: 'CodemanCanvasShot',
  target: 'es2022',
  minify: true,
});
