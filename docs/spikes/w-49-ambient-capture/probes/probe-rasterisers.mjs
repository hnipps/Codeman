import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright';
const dir = path.dirname(new URL(import.meta.url).pathname);
const srv = http.createServer((q, s) => { const f = path.join(dir, (q.url.split('?')[0] === '/' ? '/fixture.html' : q.url.split('?')[0])); if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); fs.createReadStream(f).pipe(s); });
await new Promise(r => srv.listen(0, 'localhost', r)); const port = srv.address().port;
const browser = await chromium.launch({ channel: process.env.CHANNEL || undefined, args: (process.env.FLAGS || '--auto-accept-this-tab-capture').split('|').concat(['--enable-unsafe-swiftshader']) });
const page = await browser.newPage({ viewport: { width: 700, height: 300 }, deviceScaleFactor: 1 });
await page.goto(`http://localhost:${port}/`); await page.waitForTimeout(800);
await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js' }); await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js' });
const REGIONS = { gl: [110, 70], glp: [330, 70], sandbox: [550, 70], xorigin: [110, 210], dom: [330, 210], c2d: [550, 210] };
const result = await page.evaluate(async (REGIONS) => {
  const sample = (cv, sx = 1) => { const ctx = cv.getContext('2d'); const out = {}; for (const [k, [x, y]] of Object.entries(REGIONS)) { const d = ctx.getImageData(Math.round(x * sx), Math.round(y * sx), 1, 1).data; out[k] = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join(''); } return out; };
  const res = {};
  try { const c = await html2canvas(document.body, { width: 700, height: 300, scale: 1, logging: false, useCORS: true }); res.html2canvas = sample(c); } catch (e) { res.html2canvas = String(e); }
  try { const c = await htmlToImage.toCanvas(document.body, { width: 700, height: 300, pixelRatio: 1 }); res.htmlToImage = sample(c); } catch (e) { res.htmlToImage = String(e); }
  return res;
}, REGIONS);
await page.mouse.click(5, 290); console.error('clicked');
const tab = await page.evaluate(async (REGIONS) => {
  const t0 = performance.now();
  const stream = await Promise.race([new Promise((_, j) => setTimeout(() => j(new Error('getDisplayMedia did not settle in 10 s (picker shown, nothing accepted it)')), 10000)), navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude' })]);
  const [track] = stream.getVideoTracks(); const settings = track.getSettings();
  const v = document.createElement('video'); v.muted = true; v.srcObject = stream; await v.play();
  await new Promise(r => v.requestVideoFrameCallback(r));
  const first = performance.now() - t0;
  const grab = async () => { const t = performance.now(); await new Promise(r => v.requestVideoFrameCallback(r)); const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0); return { c, ms: performance.now() - t }; };
  const g1 = await grab(); const sx = g1.c.width / innerWidth;
  const samples = [];
  for (let i = 0; i < 5; i++) samples.push((await grab()).ms);
  let second;
  try { await Promise.race([new Promise((_, j) => setTimeout(() => j(new Error('timeout 5 s')), 5000)), navigator.mediaDevices.getDisplayMedia({ video: true, preferCurrentTab: true })]); second = 'granted without activation'; } catch (e) { second = e.name + ': ' + e.message; }
  return { displaySurface: settings.displaySurface, frame: [g1.c.width, g1.c.height], firstFrameMs: Math.round(first), regrabMs: samples.map(Math.round), pixels: (() => { const ctx = g1.c.getContext('2d'); const o = {}; for (const [k, [x, y]] of Object.entries(REGIONS)) { const d = ctx.getImageData(Math.round(x * sx), Math.round(y * sx), 1, 1).data; o[k] = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join(''); } return o; })(), secondCallWithoutGesture: second, trackLiveAfter: track.readyState };
}, REGIONS).catch(e => ({ error: String(e) }));
console.log(JSON.stringify({ chromium: browser.version(), expected: { gl: '#ff0000', glp: '#00cc00', sandbox: '#0033ff', xorigin: '#e000e0', dom: '#ffd400', c2d: '#00e5e5' }, domRasterisers: result, tabCapture: tab }, null, 2));
await browser.close(); srv.close();
