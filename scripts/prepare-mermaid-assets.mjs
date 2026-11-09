#!/usr/bin/env node
/**
 * Bundle one offline renderer document for dev, packaged assets, and the CLI.
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(process.argv[2] || join(root, 'src/web/public/vendor'));
const result = await build({
  entryPoints: [join(import.meta.dirname, 'mermaid-frame.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  write: false,
});
const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">
<title>Mermaid renderer</title>
<style>html,body{margin:0;background:white;color:#111;font-family:Arial,sans-serif}svg{display:block}</style>
</head><body><script>${script}</script></body></html>`;
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'mermaid-frame.html'), html);
