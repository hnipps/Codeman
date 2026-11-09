/**
 * @fileoverview Mermaid fences render through one opaque-origin, network-disabled
 * frame. Only inert SVG images enter the Markdown document. Source stays copyable.
 * @dependency app.js calls hydrate after inserting Markdown
 */
(function () {
  'use strict';

  const queue = [];
  let frame = null;
  let frameReady = null;
  let nextId = 0;
  let running = false;
  const t = (source) => window.codemanT?.(source) || source;

  function rendererFrame() {
    if (frameReady) return frameReady;
    frame = document.createElement('iframe');
    frame.sandbox = 'allow-scripts';
    frame.title = t('Mermaid renderer');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:1200px;height:800px;border:0;pointer-events:none';
    const target = frame;
    // Fetch as the authenticated parent, not a navigation intercepted by frame recovery.
    frameReady = fetch(new URL('vendor/mermaid-frame.html', document.baseURI), {
      credentials: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    })
      .then((response) => {
        if (!response.ok) throw new Error('Mermaid renderer could not load.');
        return response.text();
      })
      .then((html) => {
        if (frame !== target) throw new Error('Mermaid renderer could not load.');
        return new Promise((resolve, reject) => {
          target.onload = () => resolve(target);
          target.onerror = () => reject(new Error('Mermaid renderer could not load.'));
          target.srcdoc = html;
          document.body.appendChild(target);
        });
      });
    return frameReady;
  }

  function render(source) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      let settled = false;
      const timer = setTimeout(() => finish(new Error('Mermaid rendering timed out.')), 15000);
      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', receive);
        if (error) {
          frame?.remove();
          frame = null;
          frameReady = null;
          reject(error);
        } else resolve(result);
      }
      function receive(event) {
        const data = event.data;
        if (
          event.source !== frame?.contentWindow ||
          event.origin !== 'null' ||
          data?.type !== 'mermaid-result' ||
          data.id !== id
        )
          return;
        if (typeof data.error === 'string') return finish(new Error(data.error));
        if (
          typeof data.svg !== 'string' ||
          data.svg.length > 4000000 ||
          !Number.isFinite(data.width) ||
          !Number.isFinite(data.height) ||
          data.width <= 0 ||
          data.height <= 0 ||
          data.width * data.height > 16000000
        ) {
          return finish(new Error('Mermaid renderer returned an invalid image.'));
        }
        finish(null, data);
      }
      window.addEventListener('message', receive);
      rendererFrame()
        .then((target) => {
          target.contentWindow.postMessage({ type: 'mermaid-render', id, source }, '*');
        })
        .catch((error) => finish(error));
    });
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const { wrap, code, preview, status } = queue.shift();
        if (!wrap.isConnected) continue;
        try {
          const result = await render(code.textContent || '');
          if (!wrap.isConnected) continue;
          const image = document.createElement('img');
          image.alt = t('Mermaid diagram');
          image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(result.svg);
          preview.replaceChildren(image);
          status.remove();
          wrap.classList.add('rv-mermaid-ready');
          wrap.querySelector('details').open = false;
        } catch (error) {
          status.textContent = 'Mermaid: ' + error.message;
          status.setAttribute('role', 'status');
        }
      }
    } finally {
      running = false;
    }
  }

  function hydrate(root) {
    root.querySelectorAll('pre > code.language-mermaid').forEach((code) => {
      const wrap = code.closest('.rv-code-wrap');
      if (!wrap || wrap.dataset.mermaid) return;
      wrap.dataset.mermaid = '1';
      wrap.classList.add('rv-mermaid-wrap');
      const preview = document.createElement('div');
      preview.className = 'rv-mermaid-preview';
      const status = document.createElement('p');
      status.className = 'rv-mermaid-status';
      status.textContent = t('Rendering Mermaid diagram...');
      const details = document.createElement('details');
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = t('Mermaid source');
      details.append(summary, wrap.querySelector('.rv-code-actions'), code.parentElement);
      wrap.append(preview, status, details);
      if ((code.textContent || '').length > 50000 || queue.length >= 32) {
        status.textContent = t('Mermaid diagram exceeds the render limit.');
        return;
      }
      queue.push({ wrap, code, preview, status });
    });
    queueMicrotask(drain);
  }

  window.CodemanMermaid = { hydrate };
})();
