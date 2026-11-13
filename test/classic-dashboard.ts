/**
 * @fileoverview For a test of the tab dashboard that loads `/` from a real server. With no stored key `/`
 * opens on the canvas, so such a test stores the shell switch as off before its server starts and `/` is the
 * dashboard, byte for byte what `/classic` answers.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dataPath } from '../src/config/instance.js';

export function openOnClassicDashboard(): void {
  const file = dataPath('settings.json');
  const stored = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  writeFileSync(file, JSON.stringify({ ...stored, canvasShellEnabled: false }));
}
