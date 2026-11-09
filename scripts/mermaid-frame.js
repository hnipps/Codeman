/**
 * @fileoverview Shared browser renderer for Markdown diagrams and the offline CLI.
 * Bundled into an isolated document by prepare-mermaid-assets.mjs.
 */
import mermaid from 'mermaid';

const MAX_SOURCE = 50_000;
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'neutral',
  fontFamily: 'Arial, sans-serif',
  htmlLabels: false,
  suppressErrorRendering: true,
  maxTextSize: MAX_SOURCE,
  maxEdges: 500,
  secure: [
    'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges',
    'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'htmlLabels',
    'suppressErrorRendering',
  ],
});

async function render(source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('Mermaid source is empty.');
  if (source.length > MAX_SOURCE) throw new Error('Mermaid source exceeds 50,000 characters.');
  // Diagram-supplied configuration is not part of this renderer's input.
  if (/%%\s*\{|^\s*---/m.test(source)) throw new Error('Mermaid configuration directives are not supported.');
  document.body.replaceChildren();
  const { svg } = await mermaid.render('diagram', source);
  if (svg.length > 4_000_000) throw new Error('Rendered diagram exceeds the output limit.');
  document.body.innerHTML = svg;
  const element = document.body.querySelector('svg');
  const box = element.viewBox.baseVal;
  if (!(box.width > 0 && box.height > 0) || box.width > 16384 || box.height > 16384) {
    throw new Error('Diagram dimensions exceed the render limit.');
  }
  element.style.maxWidth = 'none';
  element.setAttribute('width', String(Math.ceil(box.width)));
  element.setAttribute('height', String(Math.ceil(box.height)));
  return { svg: element.outerHTML, width: Math.ceil(box.width), height: Math.ceil(box.height) };
}

window.CodemanMermaidFrame = { render };
window.addEventListener('message', async (event) => {
  if (event.source !== parent || parent === window || event.data?.type !== 'mermaid-render') return;
  const id = event.data.id;
  if (!Number.isSafeInteger(id)) return;
  try {
    const result = await render(event.data.source);
    parent.postMessage({ type: 'mermaid-result', id, ...result }, '*');
  } catch (error) {
    document.body.replaceChildren();
    parent.postMessage({ type: 'mermaid-result', id, error: String(error.message || error).slice(0, 1000) }, '*');
  }
});
