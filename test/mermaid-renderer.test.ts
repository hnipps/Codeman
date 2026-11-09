/**
 * @fileoverview Bounds for the agent renderer's file and stdin input.
 */
import { describe, expect, it } from 'vitest';
import { readMermaidSource, renderMermaid } from '../src/mermaid-renderer.js';

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
