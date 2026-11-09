/**
 * @fileoverview Input bounds and instance-local launch policy for the agent renderer.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import puppeteer from 'puppeteer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMermaidCommands } from '../src/cli-mermaid.js';
import { readMermaidSource, renderMermaid } from '../src/mermaid-renderer.js';
import { safeRmHomeTree } from './mocks/index.js';

vi.mock('puppeteer', () => ({
  default: { launch: vi.fn().mockRejectedValue(new Error('Browser launch intercepted')) },
}));

async function* chunks(...values: (string | Buffer)[]) {
  yield* values;
}

describe('Mermaid agent input', () => {
  it('keeps multiline source and UTF-8 characters across byte chunks', async () => {
    const source = 'flowchart LR\n A[検証] --> B[Done]\n';
    const bytes = Buffer.from(source);
    expect(await readMermaidSource(chunks(bytes.subarray(0, 18), bytes.subarray(18)))).toBe(source);
  });

  it('refuses empty, oversized character, and oversized byte input', async () => {
    await expect(readMermaidSource(chunks(' \n'))).rejects.toThrow('empty');
    await expect(readMermaidSource(chunks('a'.repeat(50_001)))).rejects.toThrow('50,000');
    await expect(readMermaidSource(chunks(Buffer.alloc(200_001)))).rejects.toThrow('200,000');
  });

  it('refuses unsupported output before starting a browser', async () => {
    await expect(renderMermaid('flowchart LR\nA --> B', 'diagram.html')).rejects.toThrow('.png or .svg');
  });
});

describe('Mermaid host runtime', () => {
  let root: string;
  let exitCode: typeof process.exitCode;

  beforeEach(async () => {
    exitCode = process.exitCode;
    root = await mkdtemp(join(homedir(), 'mermaid-runtime-'));
    vi.stubEnv('CODEMAN_DATA_DIR', root);
    vi.mocked(puppeteer.launch).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = exitCode;
    safeRmHomeTree(root);
  });

  async function render() {
    await expect(renderMermaid('flowchart LR\n A --> B', join(root, 'diagram.png'))).rejects.toThrow(
      'Browser launch intercepted'
    );
    return vi.mocked(puppeteer.launch).mock.calls[0][0]!;
  }

  it('keeps the sandbox on when the instance has no runtime configuration', async () => {
    expect((await render()).args).not.toContain('--no-sandbox');
  });

  it.skipIf(process.platform !== 'linux')(
    'applies the approved opt-out and private libraries only to the browser child',
    async () => {
      await writeFile(join(root, 'mermaid-runtime.json'), JSON.stringify({ noSandbox: true, libraryPath: root }));
      vi.stubEnv('LD_LIBRARY_PATH', '/existing/libraries');
      const launch = await render();
      expect(launch.args).toContain('--no-sandbox');
      expect(launch.env?.LD_LIBRARY_PATH).toBe(`${root}:/existing/libraries`);
      expect(process.env.LD_LIBRARY_PATH).toBe('/existing/libraries');
    }
  );

  it.each([
    { args: [], noSandbox: true },
    { args: ['--sandbox'], noSandbox: false },
  ])('uses the saved opt-out unless the command overrides it: $args', async ({ args, noSandbox }) => {
    await writeFile(join(root, 'mermaid-runtime.json'), JSON.stringify({ noSandbox: true }));
    const input = join(root, 'diagram.mmd');
    await writeFile(input, 'flowchart LR\n A --> B');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = new Command();
    registerMermaidCommands(program);
    await program.parseAsync(['mermaid', 'render', input, '-o', join(root, 'diagram.png'), ...args], {
      from: 'user',
    });
    expect(puppeteer.launch).toHaveBeenCalled();
    expect(vi.mocked(puppeteer.launch).mock.calls[0][0]?.args?.includes('--no-sandbox')).toBe(noSandbox);
  });

  it.each(['{', '{"noSandbox":"false"}', '{"libraryPath":"relative"}', '{"libraryPath":"/one:/two"}', '{"args":[]}'])(
    'rejects invalid configuration before starting a browser: %s',
    async (source) => {
      await writeFile(join(root, 'mermaid-runtime.json'), source);
      await expect(renderMermaid('flowchart LR\n A --> B', join(root, 'diagram.png'))).rejects.toThrow(
        'Invalid Mermaid runtime configuration'
      );
      expect(puppeteer.launch).not.toHaveBeenCalled();
    }
  );
});
