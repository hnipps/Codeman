/**
 * @fileoverview Server-independent Mermaid command available to every agent CLI.
 */
import type { Command } from 'commander';
import { createReadStream } from 'node:fs';
import { readMermaidSource, renderMermaid } from './mermaid-renderer.js';
import { setupMermaidRuntime } from './mermaid-runtime-setup.js';
import { getErrorMessage } from './types.js';

export function registerMermaidCommands(program: Command): void {
  const mermaid = program.command('mermaid').description('Render Mermaid diagrams locally for inspection');
  mermaid
    .command('setup')
    .description('Restore the bundled Ubuntu 24.04 x64 native libraries for this instance')
    .option('--no-sandbox', 'Explicitly save a Chromium OS sandbox opt-out for this instance')
    .action(async (options: { sandbox: boolean }) => {
      try {
        console.log(await setupMermaidRuntime(options.sandbox === false));
      } catch (error) {
        console.error(`Mermaid setup failed: ${getErrorMessage(error)}`);
        process.exitCode = 1;
      }
    });
  mermaid
    .command('render <input>')
    .description('Render a .mmd file, or - for stdin, to PNG or SVG without a server')
    .requiredOption('-o, --output <path>', 'New .png or .svg output file (never overwrites)')
    .option('--sandbox', 'Enable the Chromium OS sandbox, overriding the local renderer configuration')
    .option('--no-sandbox', 'Explicitly disable the Chromium OS sandbox on hosts without sandbox support')
    .action(async (input: string, options: { output: string; sandbox?: boolean }) => {
      try {
        const source = await readMermaidSource(input === '-' ? process.stdin : createReadStream(input));
        await renderMermaid(source, options.output, {
          noSandbox: options.sandbox === undefined ? undefined : !options.sandbox,
        });
        console.log(options.output);
      } catch (error) {
        console.error(`Mermaid render failed: ${getErrorMessage(error)}`);
        process.exitCode = 1;
      }
    });
}
