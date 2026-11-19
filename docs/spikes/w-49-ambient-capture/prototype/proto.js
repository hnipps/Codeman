// Desktop prototype logic for the W-89 spec. Self-contained: no network, no storage.
(() => {
  const $ = (id) => document.getElementById(id);
  const cap = $('cap'), ink = $('ink'), panel = $('panel'), hint = $('hint');
  const appToast = $('appToast'), filed = $('filedToast');
  let path = [], drawing = false, toastTimer = null, toastHeld = false;

  // An app toast that would vanish after 2.5 s. Capture holds it (I1: toasts are held during the freeze).
  const startToast = () => { toastTimer = setTimeout(() => { if (!toastHeld) appToast.classList.add('gone'); }, 2500); };
  startToast();

  const size = () => {
    const r = devicePixelRatio || 1;
    ink.width = innerWidth * r; ink.height = innerHeight * r;
    ink.getContext('2d').setTransform(r, 0, 0, r, 0, 0);
  };

  // Frames: the bridged prototype frame answers with its own picture; the Mermaid frame has no bridge,
  // so it is painted as a labelled placeholder (I8).
  const placeFramePlaceholders = () => {
    cap.querySelectorAll('.placeholder').forEach((p) => p.remove());
    const body = document.querySelector('#mermaidTile .frame-body').getBoundingClientRect();
    const p = document.createElement('div');
    p.className = 'placeholder';
    p.textContent = 'Frame not captured';
    Object.assign(p.style, { left: body.left + 'px', top: body.top + 'px', width: body.width + 'px', height: body.height + 'px' });
    cap.insertBefore(p, hint);
  };

  const freeze = () => {
    if (!cap.hidden) return;
    toastHeld = true; appToast.classList.remove('gone');   // freeze first: nothing changes before the picture
    size(); placeFramePlaceholders();
    cap.hidden = false; panel.hidden = true; hint.hidden = false; path = [];
    ink.getContext('2d').clearRect(0, 0, innerWidth, innerHeight);
  };
  const close = () => {
    cap.hidden = true; toastHeld = false;
    clearTimeout(toastTimer); appToast.classList.add('gone');
  };

  const draw = () => {
    const g = ink.getContext('2d');
    g.clearRect(0, 0, innerWidth, innerHeight);
    if (path.length < 2) return;
    g.fillStyle = '#0006'; g.fillRect(0, 0, innerWidth, innerHeight);
    g.save(); g.beginPath(); path.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
    g.globalCompositeOperation = 'destination-out'; g.fill(); g.restore();
    g.beginPath(); path.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    if (!drawing) g.closePath();
    g.lineWidth = 3; g.lineJoin = 'round'; g.strokeStyle = '#ff5370'; g.stroke();
  };

  const showPanel = () => {
    const xs = path.map((p) => p[0]), ys = path.map((p) => p[1]);
    const right = Math.max(...xs), top = Math.min(...ys);
    let left = right + 16; if (left + 330 > innerWidth) left = Math.max(8, Math.min(...xs) - 336);
    panel.style.left = left + 'px'; panel.style.top = Math.max(56, Math.min(top, innerHeight - 260)) + 'px';
    $('facts').textContent = 'Files to api (the shown session’s case) · clean, marked crop, marked wide, capture.json';
    panel.hidden = false; hint.hidden = true;
  };

  cap.addEventListener('pointerdown', (e) => {
    if (panel.contains(e.target)) return;
    drawing = true; path = [[e.clientX, e.clientY]]; panel.hidden = true; cap.setPointerCapture(e.pointerId);
  });
  cap.addEventListener('pointermove', (e) => { if (drawing) { path.push([e.clientX, e.clientY]); draw(); } });
  cap.addEventListener('pointerup', () => { if (!drawing) return; drawing = false; draw(); if (path.length > 4) showPanel(); });

  $('redraw').onclick = () => { path = []; draw(); panel.hidden = true; hint.hidden = false; };
  $('cancel').onclick = close;
  panel.addEventListener('submit', (e) => {
    e.preventDefault(); close();
    filed.hidden = false; setTimeout(() => (filed.hidden = true), 6000);
  });
  $('captureBtn').onclick = freeze;
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !cap.hidden) close();
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'x') { e.preventDefault(); freeze(); }
  });

  // Fixed states for screenshots and for clicking through.
  const sample = () => {
    const cx = innerWidth * 0.14, cy = 166, rx = innerWidth * 0.13, ry = 26;
    return Array.from({ length: 60 }, (_, i) => {
      const a = (i / 60) * Math.PI * 2;
      return [cx + Math.cos(a) * rx * (1 + 0.05 * Math.sin(a * 3)), cy + Math.sin(a) * ry];
    });
  };
  const state = location.hash.slice(1);
  if (state === 'frozen' || state === 'frames') freeze();
  if (state === 'drawn') { freeze(); path = sample(); draw(); showPanel(); }
  if (state === 'filed') { appToast.classList.add('gone'); filed.hidden = false; $('pending').hidden = true; }
  if (state === 'pending') { appToast.classList.add('gone'); $('pending').hidden = false; }
})();
