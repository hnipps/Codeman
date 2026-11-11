/**
 * @fileoverview Offline Mermaid image rendering through the UI's isolated document.
 * Chromium has no network access. The browser sandbox stays enabled unless explicitly disabled.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadlessBrowser } from './headless-browser.js';

const MAX_SOURCE_BYTES = 200_000;
const RENDER_TIMEOUT_MS = 15_000;
const RENDER_URL = 'https://codeman-mermaid.invalid/';

export async function readMermaidSource(input: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_SOURCE_BYTES) throw new Error('Mermaid input exceeds 200,000 bytes.');
    chunks.push(buffer);
  }
  const source = Buffer.concat(chunks).toString('utf8');
  if (!source.trim()) throw new Error('Mermaid source is empty.');
  if (source.length > 50_000) throw new Error('Mermaid source exceeds 50,000 characters.');
  return source;
}

export async function renderMermaid(
  source: string,
  output: string,
  options: { noSandbox?: boolean } = {}
): Promise<void> {
  const format = extname(output).toLowerCase();
  if (format !== '.png' && format !== '.svg') throw new Error('Output must end in .png or .svg.');
  const document = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), 'web/public/vendor/mermaid-frame.html'),
    'utf8'
  );
  const browser = await launchHeadlessBrowser({ noSandbox: options.noSandbox, timeoutMs: RENDER_TIMEOUT_MS });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = async (): Promise<string | Uint8Array> => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        if (request.url() === RENDER_URL && request.isNavigationRequest()) {
          void request.respond({ status: 200, contentType: 'text/html', body: document });
        } else {
          void request.abort();
        }
      });
      await page.goto(RENDER_URL, { waitUntil: 'domcontentloaded' });
      const result = (await page.evaluate(
        `(async () => window.CodemanMermaidFrame.render(${JSON.stringify(source)}))()`
      )) as { svg: string; width: number; height: number };
      if (result.width * result.height > 16_000_000) throw new Error('Diagram exceeds 16 million pixels.');
      if (format === '.svg') {
        return result.svg;
      } else {
        return page.screenshot({
          type: 'png',
          clip: { x: 0, y: 0, width: result.width, height: result.height },
          captureBeyondViewport: true,
        });
      }
    };
    const image = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Mermaid rendering timed out.')), RENDER_TIMEOUT_MS);
      }),
    ]);
    await writeFile(output, image, { flag: 'wx' });
  } finally {
    clearTimeout(timer);
    await browser.close();
  }
}
