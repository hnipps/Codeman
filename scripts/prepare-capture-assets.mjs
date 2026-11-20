#!/usr/bin/env node
/**
 * Copy the capture rasteriser (html-to-image's UMD build) into a public vendor
 * dir. Run by postinstall for dev (src/web/public/vendor, gitignored) and by
 * build.mjs for prod (dist/web/public/vendor). The package is pinned exactly in
 * package.json, so the patch below always meets the text it expects.
 * Source-map comments are stripped: the maps are not shipped.
 */

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const outputDir = resolve(process.argv[2] || join(import.meta.dirname, '..', 'src', 'web', 'public', 'vendor'));
const source = require.resolve('html-to-image/dist/html-to-image.js');

const PATCHES = [
  // I3 (NoPasswordLeavesThePage): 1.11.11 has no clone-hook option, so the masking
  // is patched into its cloneInputValue, which copies an input's live value onto the clone.
  [
    'd(t,HTMLInputElement)&&e.setAttribute("value",t.value)',
    'd(t,HTMLInputElement)&&e.setAttribute("value","password"===t.type?"\\u2022".repeat(t.value.length):t.value)',
  ],
  // A same-origin iframe was replaced by a clone of its body (without the caller's options,
  // children appended twice), and Chromium paints nothing, not even the border, for an iframe
  // inside an SVG image. Each iframe becomes an empty div carrying its computed style, so its
  // box, border and the layout around it survive; capture.js paints the frame's raster into it.
  ['d(t,HTMLIFrameElement)?[2,T(t)]', 'd(t,HTMLIFrameElement)?[2,document.createElement("div")]'],
  [
    'd(t,HTMLIFrameElement)&&(null===(u=t.contentDocument)||void 0===u?void 0:u.body)?o(t.contentDocument.body.childNodes):',
    '',
  ],
  // An iframe is an atomic inline; as a div it needs inline-block, not the stock block, to stay in its line.
  [
    'd(t,HTMLIFrameElement)&&"display"===i&&"inline"===o&&(o="block")',
    'd(t,HTMLIFrameElement)&&"display"===i&&"inline"===o&&(o="inline-block")',
  ],
];

let content = readFileSync(source, 'utf8').replace(/\n?\/\/# sourceMappingURL=.*(?:\n|$)/g, '\n');
if (/sourceMappingURL/.test(content)) {
  throw new Error('Failed to strip sourceMappingURL from html-to-image.js');
}
for (const [from, to] of PATCHES) {
  const hits = content.split(from).length - 1;
  if (hits !== 1) {
    throw new Error(
      `html-to-image.js: expected exactly one \`${from}\`, found ${hits}; the capture patches would not apply`
    );
  }
  content = content.replace(from, () => to);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html-to-image.js'), content, 'utf8');
