/**
 * @fileoverview Real Mermaid images in Markdown readers and the offline agent command.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { safeRmHomeTree } from './mocks/index.js';

const execute = promisify(execFile);
const SOURCE = 'flowchart LR\n A[Agent] --> B[Checked diagram]';
const MARKDOWN = '# Diagram\n\n```mermaid\n' + SOURCE + '\n```\n\n```js\nconsole.log("kept");\n```';

describe('Mermaid diagrams', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(homedir(), 'mermaid-'));
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
    });
    page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1 });
    await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean((window as any).app && (window as any).CodemanMermaid));
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    if (root) safeRmHomeTree(root);
  }, 60000);

  async function message(markdown: string) {
    await page.evaluate((text) => {
      document.getElementById('mermaid-test')?.remove();
      const body = document.createElement('section');
      body.id = 'mermaid-test';
      body.style.cssText = 'position:fixed;inset:20px;z-index:20000;overflow:auto;background:#fff;color:#111';
      const app = (window as any).app;
      body.appendChild(app._buildResponseViewerMessage(text, 'assistant', 'Agent'));
      app._bindResponseViewerInteractions(body);
      document.body.appendChild(body);
    }, markdown);
  }

  it('renders response/chat Markdown as an inert image and preserves source and ordinary code', async () => {
    await message(MARKDOWN);
    await page.waitForFunction(() => {
      const image = document.querySelector('#mermaid-test .rv-mermaid-preview img') as HTMLImageElement;
      return image?.naturalWidth > 0;
    });
    expect(await page.locator('#mermaid-test svg, #mermaid-test script, #mermaid-test iframe').count()).toBe(0);
    expect(await page.locator('#mermaid-test code.language-js').textContent()).toContain('console.log');
    const details = page.locator('#mermaid-test details');
    expect(await details.getAttribute('open')).toBeNull();
    await details.locator('summary').click();
    expect(await details.locator('code').textContent()).toBe(SOURCE + '\n');
    await page.evaluate(() => {
      (window as any).app._copyText = async (text: string) => {
        (window as any).__copiedMermaid = text;
        return true;
      };
    });
    await page.locator('#mermaid-test .rv-mermaid-wrap .rv-copy-btn').click();
    expect(await page.evaluate(() => (window as any).__copiedMermaid)).toBe(SOURCE + '\n');
    const frame = page.locator('iframe[title="Mermaid renderer"]');
    expect(await frame.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('renders the file viewer on a phone without horizontal page overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await writeFile(join(root, 'README.md'), MARKDOWN);
    await page.evaluate(async (workingDir) => {
      document.getElementById('mermaid-test')?.remove();
      const app = (window as any).app;
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir, mode: 'shell' }),
      });
      const id = (await response.json()).data.session.id;
      await app.openFilePreview(workingDir + '/README.md', id);
    }, root);
    await page.waitForFunction(() => {
      const image = document.querySelector('#filePreviewBody .rv-mermaid-preview img') as HTMLImageElement;
      return image?.naturalWidth > 0;
    });
    const dimensions = await page.locator('#filePreviewBody .rv-mermaid-preview').evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      image: element.querySelector('img')!.getBoundingClientRect().width,
    }));
    expect(dimensions.image).toBeLessThanOrEqual(dimensions.width);
    await page.screenshot({ path: resolve('test-results', `mermaid-mobile-${Date.now()}.png`) });
  });

  it('keeps invalid and configuration-bearing diagrams readable and renders the next valid diagram', async () => {
    await message(
      '```mermaid\nnot a diagram\n```\n\n```mermaid\n%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B\n```\n\n```mermaid\n' +
        SOURCE +
        '\n```'
    );
    await page.waitForFunction(() => document.querySelectorAll('#mermaid-test [role="status"]').length === 2);
    await page.waitForFunction(() => Boolean(document.querySelector('#mermaid-test .rv-mermaid-ready img')));
    expect(await page.locator('#mermaid-test details[open]').count()).toBe(2);
    expect(await page.locator('#mermaid-test [role="status"]').allTextContents()).toEqual(
      expect.arrayContaining([expect.stringContaining('configuration directives')])
    );
  });

  it('renders sequence diagrams and does not fetch label resources', async () => {
    const externalRequests: string[] = [];
    const record = (request: import('playwright').Request) => {
      if (request.url().includes('mermaid-egress.invalid')) externalRequests.push(request.url());
    };
    page.on('request', record);
    try {
      await message(
        '```mermaid\nsequenceDiagram\n Agent->>Renderer: Check diagram\n Renderer-->>Agent: Image\n```\n\n' +
          '```mermaid\nflowchart LR\n A["<img src=\'https://mermaid-egress.invalid/pixel\' />"] --> B[Safe]\n```'
      );
      await page.waitForFunction(() => document.querySelectorAll('#mermaid-test .rv-mermaid-ready img').length === 2);
      expect(externalRequests).toEqual([]);
      expect(await page.locator('#mermaid-test svg, #mermaid-test script').count()).toBe(0);
    } finally {
      page.off('request', record);
    }
  });

  it('the offline CLI writes decodable PNG and SVG and fails invalid input without an output', async () => {
    const input = join(root, 'diagram.mmd');
    await writeFile(input, SOURCE);
    const cli = resolve('node_modules/tsx/dist/cli.mjs');
    for (const ext of ['png', 'svg']) {
      const output = join(root, `diagram.${ext}`);
      const result = await execute(process.execPath, [
        cli,
        'src/index.ts',
        'mermaid',
        'render',
        input,
        '-o',
        output,
        '--no-sandbox',
      ]);
      expect(result.stdout.trim()).toBe(output);
      const data = await readFile(output);
      if (ext === 'png') {
        const png = PNG.sync.read(data);
        expect(png.width).toBeGreaterThan(100);
        expect(png.height).toBeGreaterThan(30);
        expect(png.data.some((value, i) => i % 4 !== 3 && value < 100)).toBe(true);
      } else {
        expect(data.toString()).toContain('<svg');
        const labels = await page.evaluate((svg) => {
          const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
          return [...document.querySelectorAll('text')].map((element) => element.textContent).join(' ');
        }, data.toString());
        expect(labels).toMatch(/Checked\s*diagram/);
      }
    }
    const existing = join(root, 'diagram.png');
    const original = await readFile(existing);
    await expect(
      execute(process.execPath, [cli, 'src/index.ts', 'mermaid', 'render', input, '-o', existing, '--no-sandbox'])
    ).rejects.toMatchObject({ code: 1 });
    expect(await readFile(existing)).toEqual(original);
    await writeFile(input, 'not a diagram');
    const output = join(root, 'invalid.png');
    await expect(
      execute(process.execPath, [cli, 'src/index.ts', 'mermaid', 'render', input, '-o', output, '--no-sandbox'])
    ).rejects.toMatchObject({ code: 1 });
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60000);
});
