/**
 * @fileoverview Server-independent Mermaid command available to every agent CLI.
 */
import type { Command } from 'commander';
import { createReadStream } from 'node:fs';
import { readMermaidSource, renderMermaid } from './mermaid-renderer.js';
import { getErrorMessage } from './types.js';

export function registerMermaidCommands(program: Command): void {
  program
    .command('mermaid')
    .description('Render Mermaid diagrams locally for inspection')
    .command('render <input>')
    .description('Render a .mmd file, or - for stdin, to PNG or SVG without a server')
    .requiredOption('-o, --output <path>', 'New .png or .svg output file (never overwrites)')
    .option('--no-sandbox', 'Explicitly disable the Chromium OS sandbox on hosts without sandbox support')
    .action(async (input: string, options: { output: string; sandbox: boolean }) => {
      try {
        const source = await readMermaidSource(input === '-' ? process.stdin : createReadStream(input));
        await renderMermaid(source, options.output, { noSandbox: options.sandbox === false });
        console.log(options.output);
      } catch (error) {
        console.error(`Mermaid render failed: ${getErrorMessage(error)}`);
        process.exitCode = 1;
      }
    });
}
