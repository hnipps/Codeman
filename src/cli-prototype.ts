/**
 * @fileoverview `codeman prototype capture`: drive a running web app through a states spec in a local
 * headless browser and write a clickable static prototype folder. Needs no Codeman server; publish
 * the folder with `canvas_prototype publish` (or use `canvas_prototype capture`, which does both).
 */
import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { getErrorMessage } from './types.js';

export function registerPrototypeCommands(program: Command): void {
  const prototype = program.command('prototype').description('Build canvas prototypes locally');
  prototype
    .command('capture <spec>')
    .description('Capture a running web app through the states in a JSON spec, as a clickable static prototype folder')
    .requiredOption('-o, --output <dir>', 'New or empty folder to write (never overwrites)')
    .option('--sandbox', 'Enable the Chromium OS sandbox, overriding the local renderer configuration')
    .option('--no-sandbox', 'Explicitly disable the Chromium OS sandbox on hosts without sandbox support')
    .action(async (specPath: string, options: { output: string; sandbox?: boolean }) => {
      try {
        const { capturePrototype, writeCapturedPrototype } = await import('./canvas/prototype-capture.js');
        const spec: unknown = JSON.parse(await readFile(specPath, 'utf8'));
        const captured = await capturePrototype(spec, {
          noSandbox: options.sandbox === undefined ? undefined : !options.sandbox,
          log: (line) => console.error(line),
        });
        await writeCapturedPrototype(options.output, captured.files);
        for (const warning of captured.warnings) console.error(`warning: ${warning}`);
        console.log(`${options.output} (${captured.files.length} files, entry ${captured.entry})`);
      } catch (error) {
        console.error(`Prototype capture failed: ${getErrorMessage(error)}`);
        process.exitCode = 1;
      }
    });
}
