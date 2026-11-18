import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright';
const dir = path.dirname(new URL(import.meta.url).pathname);
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const srv = http.createServer((q, s) => { const f = path.join(dir, q.url.split('?')[0]); if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': types[path.extname(f)] }); fs.createReadStream(f).pipe(s); });
await new Promise(r => srv.listen(0, 'localhost', r));
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 700, height: 300 }, deviceScaleFactor: 1 });
await page.goto(`http://localhost:${srv.address().port}/fixture2.html`); await page.waitForTimeout(1500);
await page.mouse.move(100, 180); await page.waitForTimeout(200);
const P = { termDefault: [150, 50], termPreserve: [490, 50], hover: [100, 190], toast: [340, 190], frame: [560, 200] };

const r = await page.evaluate(async (P) => {
  const hex = (ctx, x, y) => { const d = ctx.getImageData(x, y, 1, 1).data; return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join(''); };
  const times = [];
  let c;
  for (let i = 0; i < 3; i++) { const t = performance.now(); c = await htmlToImage.toCanvas(document.body, { width: 700, height: 300, pixelRatio: 1 }); times.push(Math.round(performance.now() - t)); }
  const ctx = c.getContext('2d'); const page = {}; for (const [k, [x, y]] of Object.entries(P)) page[k] = hex(ctx, x, y);
  const t = performance.now(); const url = await frameCapture(); const frameMs = Math.round(performance.now() - t);
  const img = new Image(); img.src = url; await img.decode(); const fc = document.createElement('canvas'); fc.width = img.width; fc.height = img.height; fc.getContext('2d').drawImage(img, 0, 0);
  return { domRasteriseMs: times, page, frameSelfCapture: { ms: frameMs, size: [img.width, img.height], pixel: hex(fc.getContext('2d'), 100, 50) } };
}, P);
console.log(JSON.stringify({ expected: { termDefault: 'red-ish #cd3131 cell bg', termPreserve: 'same', hover: '#00a000 while hovered', toast: '#ff8000', frame: '#0033ff' }, ...r }, null, 2));
await browser.close(); srv.close();
