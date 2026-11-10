import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const require = createRequire(import.meta.url);
const xtermScript = require.resolve('@xterm/xterm');
const publicRoot = resolve(import.meta.dirname, '../src/web/public');
const reportPath =
  '/home/codeman/.copilot/session-state/dccb5cea-61ce-4355-a343-6e2e92836ff8/files/temporal-actionable-contribution/TEMPORAL-REPORT.md';

type Opened = { kind: 'file' | 'log' | 'folder'; file: string; session: string } | { kind: 'url'; url: string };

let browser: Browser;
let page: Page;

beforeEach(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.setContent('<html><body style="margin:0"><div id="terminal"></div></body></html>');
  await page.addStyleTag({ path: resolve(dirname(xtermScript), '../css/xterm.css') });
  await page.addScriptTag({ path: xtermScript });
  await page.addScriptTag({ content: 'window.CodemanApp = class CodemanApp {};' });
  await page.addScriptTag({ path: resolve(publicRoot, 'constants.js') });
  await page.addScriptTag({ path: resolve(publicRoot, 'terminal-ui.js') });
  await page.addScriptTag({
    content: `
      const app = window.app = new CodemanApp();
      window.opened = [];
      window.confirm = () => true;
      app.activeSessionId = 'primary-session';
      app.sessions = new Map([['primary-session', { workingDir: '/workspace' }]]);
      app.openFilePreview = (file, session) => opened.push({ kind: 'file', file, session });
      app.openLogViewerWindow = (file, session) => opened.push({ kind: 'log', file, session });
      app.openFolderGrid = (file, session) => opened.push({ kind: 'folder', file, session });
      app._isExternalPreviewPath = () => true;
      app._openTerminalUrl = url => opened.push({ kind: 'url', url });
      app.terminal = new Terminal({
        cols: 90, rows: 20, fontSize: 16, allowProposedApi: true,
        linkHandler: app._terminalOsc8LinkHandler()
      });
      app.terminal.open(document.querySelector('#terminal'));
      app.registerFilePathLinkProvider();
    `,
  });
});

afterEach(async () => {
  await browser?.close();
});

async function write(text: string) {
  await page.evaluate(
    `new Promise(resolve => {
      app.terminal.reset();
      opened.length = 0;
      app.terminal.write(${JSON.stringify(text)}, resolve);
    })`
  );
  await page.waitForTimeout(100);
}

async function clickCell(col: number, row: number) {
  await page.mouse.move(950, 650);
  await page.waitForTimeout(30);
  const position = await page.evaluate(
    ({ col, row }) => {
      const screen = document.querySelector('.xterm-screen');
      if (!screen) throw new Error('Terminal screen is missing');
      const rect = screen.getBoundingClientRect();
      return { x: rect.x + ((col + 0.5) * rect.width) / 90, y: rect.y + ((row + 0.5) * rect.height) / 20 };
    },
    { col, row }
  );
  await page.mouse.move(position.x, position.y);
  await page.waitForTimeout(150);
  await page.mouse.click(position.x, position.y);
}

function opened() {
  return page.evaluate<Opened[]>('window.opened');
}

describe('local links in agent terminal responses', () => {
  it.each(['/tmp/report.md', 'file:///tmp/report.md'])('opens the hidden local destination of %s', async (uri) => {
    await write(`\x1b]8;;${uri}\x07Open the report\x1b]8;;\x07\r\n`);
    await clickCell(5, 0);
    await expect.poll(opened).toEqual([{ kind: 'file', file: '/tmp/report.md', session: 'primary-session' }]);
  });

  it.each(['┃', '|'])('opens the complete path from every row with a %s gutter', async (border) => {
    const rows = [reportPath.slice(0, 58), reportPath.slice(58, 116), reportPath.slice(116)];
    await write(rows.map((row) => `${border}   ${row}`).join('\r\n') + '\r\n');
    for (let row = 0; row < rows.length; row++) {
      await page.evaluate('window.opened.length = 0');
      await clickCell(8, row);
      await expect.poll(opened).toEqual([{ kind: 'file', file: reportPath, session: 'primary-session' }]);
      await page.evaluate('window.opened.length = 0');
      await clickCell(0, row);
      expect(await opened()).toEqual([]);
    }
  });

  it('resolves a hidden OSC 8 target through the native provider for touch lookup', async () => {
    await write('\x1b]8;;file:///tmp/report.md\x07Open the report\x1b]8;;\x07\r\n');
    const target = await page.evaluate(`(() => {
      const rect = document.querySelector('.xterm-screen').getBoundingClientRect();
      const cell = app.terminal._core._renderService.dimensions.css.cell;
      const link = app._terminalLinkAtPoint(rect.left + cell.width * 5.5, rect.top + cell.height * 0.5);
      if (!link) return null;
      link.activate(null, link.text);
      return link.text;
    })()`);
    expect(target).toBe('file:///tmp/report.md');
    expect(await opened()).toEqual([{ kind: 'file', file: '/tmp/report.md', session: 'primary-session' }]);
  });

  it('opens a path split across two full-width bordered rows', async () => {
    await write(`┃   ${reportPath.slice(0, 86)}\r\n┃   ${reportPath.slice(86)}\r\n`);
    for (const row of [0, 1]) {
      await page.evaluate('window.opened.length = 0');
      await clickCell(8, row);
      await expect.poll(opened).toEqual([{ kind: 'file', file: reportPath, session: 'primary-session' }]);
    }
  });

  it('preserves web links', async () => {
    await write('\x1b]8;;https://example.com/report\x07Open the report\x1b]8;;\x07\r\n');
    await clickCell(5, 0);
    await expect.poll(opened).toEqual([{ kind: 'url', url: 'https://example.com/report' }]);
  });
});
