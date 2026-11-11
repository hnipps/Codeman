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
