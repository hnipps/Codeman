/**
 * @fileoverview Shared headless Chromium launch for Mermaid and canvas screenshots.
 * The sandbox stays on unless the caller or mermaid-runtime.json opts out.
 * A Linux libraryPath is applied only to the browser child.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { dataPath } from './config/instance.js';

const RuntimeConfigSchema = z
  .object({
    noSandbox: z.boolean().optional(),
    libraryPath: z
      .string()
      .refine((path) => isAbsolute(path) && !path.includes(':') && !path.includes('\0'))
      .optional(),
  })
  .strict();

async function readRuntimeConfig(): Promise<z.infer<typeof RuntimeConfigSchema>> {
  const path = dataPath('mermaid-runtime.json');
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  try {
    return RuntimeConfigSchema.parse(JSON.parse(source));
  } catch {
    throw new Error(`Invalid Mermaid runtime configuration in ${path}.`);
  }
}

export async function launchHeadlessBrowser(options: { noSandbox?: boolean; timeoutMs?: number } = {}) {
  const config = await readRuntimeConfig();
  if (config.libraryPath && process.platform !== 'linux') {
    throw new Error('Mermaid libraryPath is supported only on Linux.');
  }
  const { default: puppeteer } = await import('puppeteer');
  return puppeteer.launch({
    headless: 'shell',
    timeout: options.timeoutMs ?? 15_000,
    args: (options.noSandbox ?? config.noSandbox ?? false) ? ['--no-sandbox'] : [],
    env: config.libraryPath
      ? {
          ...process.env,
          LD_LIBRARY_PATH: [config.libraryPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
        }
      : undefined,
  });
}
