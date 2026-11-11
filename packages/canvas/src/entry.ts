import { joinBasePath } from '../../../src/config/base-path.js';
import { command, initialView, type ViewCommand, type ViewState } from './commands.js';
import { container, label, readable, type ViewObject } from './model.js';
import { Renderer } from './render.js';
import { CanvasSync } from './sync.js';
import { shortcutAllowed, shortcuts } from './shortcuts.js';
import { outline, siblings, worldBounds } from './tree.js';
import { hit, union, type Point } from './viewport.js';

declare global {
  interface Window {
    canvasView: { dispatch: (action: ViewCommand) => void; read: () => ViewState };
  }
}
function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`Missing canvas element: ${id}`);
  return el;
}
const node = (id: string): HTMLElement => element(id, HTMLElement);
const button = (id: string): HTMLButtonElement => element(id, HTMLButtonElement);
const input = (id: string): HTMLInputElement => element(id, HTMLInputElement);
const board = node('board'),
  layer = node('layer'),
  tree = node('tree');
const base = new URL(document.baseURI).pathname.replace(/\/$/, '');
const url = (path: string): string => joinBasePath(base, path);
const workspaceId = location.pathname.split('/').filter(Boolean).at(-1) ?? '';
let state = initialView(),
  objects: ViewObject[] = [],
  keyboard = false,
  frame = 0;
const railOrigins = new Map<string, HTMLElement>();
let initial = true,
  pendingFocus: HTMLElement | null = null,
  railDepth = 0;
const mobile = matchMedia('(max-width: 600px)');
state = command(state, { kind: 'outline', open: !mobile.matches }, objects);
const renderer = new Renderer(layer, tree, choose);
const icons: Record<string, string> = {
  selectTool: 'M5 3l12 8-6 1-3 6z',
  panTool:
    'M7 10V5a1 1 0 0 1 2 0v4-1-5a1 1 0 0 1 2 0v5-1-3a1 1 0 0 1 2 0v4-1-2a1 1 0 0 1 2 0v6c0 4-2 6-5 6-2 0-3-1-4-3l-3-5a1 1 0 0 1 2-1z',
  addTool: 'M10 3v14M3 10h14',
  chatTool: 'M3 3h14v11H8l-5 4zM6 7h8M6 10h5',
  keys: 'M6 6a4 4 0 1 1 6 4c-2 1-2 2-2 3M10 17h.01',
  closeOutline: 'M13 4l-6 6 6 6',
  openOutline: 'M3 4h14v12H3zM7 4v12',
  closeRail: 'M5 5l10 10M15 5L5 15',
};
for (const [id, path] of Object.entries(icons)) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(svg.namespaceURI, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  node(id).append(svg);
}
function theme(): void {
  try {
    const skin = localStorage.getItem('codeman:skin') ?? 'daylight-blue';
    const light = [
      'daylight-green',
      'daylight-blue',
      'paper-gray',
      'solarized-light',
      'catppuccin-latte',
      'rose-pine-dawn',
    ].includes(skin);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
  } catch {
    document.documentElement.dataset.theme = 'dark';
  }
}
theme();
window.addEventListener('storage', theme);
function area() {
  return {
    x: state.outlineOpen && !mobile.matches ? 192 : 0,
    y: 0,
    width: innerWidth - (state.outlineOpen && !mobile.matches ? 192 : 0),
    height: innerHeight,
  };
}
function fit(ids?: string[]): void {
  const targets = objects.filter((o) => o.deletedAt === null && (!ids || ids.includes(o.id)));
  dispatch({ kind: 'fit', bounds: union(targets.map((o) => worldBounds(objects, o))), area: area() });
}
function reveal(id: string): void {
  const o = objects.find((o) => o.id === id);
  if (!o) return;
  const r = worldBounds(objects, o),
    v = state.viewport,
    a = area();
  const x = (r.x + r.width / 2) * v.zoom + v.x,
    y = (r.y + r.height / 2) * v.zoom + v.y;
  if (!hit({ x: a.x + 32, y: 48, width: Math.max(1, a.width - 64), height: a.height - 144 }, { x, y }))
    dispatch({ kind: 'pan', delta: { x: a.x + a.width / 2 - x, y: a.height / 2 - y } });
}
function choose(id: string, toggle: boolean, bring: boolean): void {
  keyboard = false;
  dispatch({ kind: 'focus', id });
  dispatch(toggle ? { kind: 'toggle', id } : { kind: 'selection', ids: [id] });
  if (bring) {
    if (mobile.matches) dispatch({ kind: 'outline', open: false });
    reveal(id);
  }
  board.focus({ preventScroll: true });
}
function dispatch(action: ViewCommand): void {
  if (action.kind === 'rail' && state.rail.at(-1) !== action.view)
    railOrigins.set(action.view, document.activeElement instanceof HTMLElement ? document.activeElement : board);
  const closing = state.rail.at(-1);
  const previous = state.rail.length;
  state = command(state, action, objects);
  if (action.kind === 'navigate' || action.kind === 'focus') {
    if (keyboard) {
      renderer.elements.get(state.focusId ?? '')?.focus({ preventScroll: true });
      if (state.focusId) reveal(state.focusId);
    }
  }
  if (action.kind === 'escape' && previous) {
    const origin = closing ? railOrigins.get(closing) : board;
    pendingFocus = origin?.isConnected ? origin : board;
  }
  if (action.kind === 'outline') {
    node('outline').hidden = !action.open;
    (action.open ? input('search') : board).focus({ preventScroll: true });
  }
  if (!frame) frame = requestAnimationFrame(paint);
}
window.canvasView = { dispatch, read: () => structuredClone(state) };
function paint(): void {
  frame = 0;
  renderer.view(state, keyboard);
  node('outline').hidden = !state.outlineOpen;
  node('openOutline').hidden = state.outlineOpen;
  node('rail').hidden = !state.rail.length;
  node('keysView').hidden = state.rail.at(-1) !== 'keys';
  node('readerView').hidden = state.rail.at(-1) !== 'reader';
  node('railTitle').textContent = state.rail.at(-1) === 'reader' ? 'Object reader' : 'Keys';
  button('selectTool').setAttribute('aria-pressed', String(state.tool === 'select'));
  button('panTool').setAttribute('aria-pressed', String(state.tool === 'pan'));
  board.classList.toggle('panning', state.tool === 'pan' || spaceHeld);
  node('letters').textContent = `Single-letter shortcuts: ${state.letters ? 'on' : 'off'}`;
  if (
    state.rail.at(-1) === 'reader' &&
    (readerObject !== objects.find((o) => o.id === state.focusId) || readerFocus !== state.focusId)
  )
    readObject();
  if (state.rail.length > railDepth && state.rail.at(-1) === 'keys') input('keysSearch').focus();
  if (pendingFocus) {
    pendingFocus.focus({ preventScroll: true });
    pendingFocus = null;
  }
  railDepth = state.rail.length;
}
let readerObject: ViewObject | undefined,
  readerFocus: string | null = null;
function readObject(): void {
  const o = objects.find((o) => o.id === state.focusId);
  readerObject = o;
  readerFocus = state.focusId;
  node('readerTitle').textContent = o ? label(o) : 'Object no longer available';
  node('readerText').textContent = o ? readable(o) : 'This object was removed from the workspace.';
  node('readerMeta').replaceChildren();
  if (o)
    for (const [title, value] of [
      ['Author', o.author.kind === 'human' ? o.author.userId : `Agent · ${o.author.sessionId}`],
      ['Created', new Date(o.createdAt).toLocaleString()],
      ['Updated', new Date(o.updatedAt).toLocaleString()],
    ]) {
      const dt = document.createElement('dt'),
        dd = document.createElement('dd');
      dt.textContent = title;
      if (title === 'Created' || title === 'Updated') {
        const time = document.createElement('time');
        time.dateTime = new Date(title === 'Created' ? o.createdAt : o.updatedAt).toISOString();
        time.textContent = value;
        dd.append(time);
      } else dd.textContent = value;
      node('readerMeta').append(dt, dd);
    }
  button('parent').hidden = !o?.parentId;
  button('children').hidden = !o || !siblings(objects, o.id).length;
}
for (const [action, key] of shortcuts) {
  const row = document.createElement('div'),
    title = document.createElement('span'),
    hint = document.createElement('kbd');
  row.className = 'key-row';
  title.textContent = action;
  hint.textContent = key;
  row.append(title, hint);
  node('keyRows').append(row);
}
input('keysSearch').oninput = () => {
  for (const row of node('keyRows').children)
    if (row instanceof HTMLElement)
      row.hidden = !row.textContent?.toLowerCase().includes(input('keysSearch').value.toLowerCase());
};
input('search').oninput = () => renderer.filter(input('search').value);
button('openOutline').onclick = () => {
  dispatch({ kind: 'outline', open: true });
  input('search').focus();
};
button('closeOutline').onclick = () => {
  dispatch({ kind: 'outline', open: false });
  board.focus();
};
button('closeRail').onclick = () => dispatch({ kind: 'escape' });
for (const id of ['keys', 'outlineKeys']) button(id).onclick = () => dispatch({ kind: 'rail', view: 'keys' });
button('letters').onclick = () => dispatch({ kind: 'letters', enabled: !state.letters });
button('selectTool').onclick = () => dispatch({ kind: 'tool', tool: 'select' });
button('panTool').onclick = () => dispatch({ kind: 'tool', tool: 'pan' });
button('fit').onclick = () => fit(state.selected.length ? state.selected : undefined);
function parent(): void {
  const o = objects.find((o) => o.id === state.focusId);
  if (o?.parentId) {
    keyboard = true;
    dispatch({ kind: 'focus', id: o.parentId });
  }
}
function child(): void {
  const o = siblings(objects, state.focusId)[0];
  if (o) {
    keyboard = true;
    dispatch({ kind: 'focus', id: o.id });
  }
}
button('parent').onclick = parent;
button('children').onclick = child;
let composing = false,
  spaceHeld = false,
  spaceMoved = false;
document.addEventListener('compositionstart', () => (composing = true));
document.addEventListener('compositionend', () => (composing = false));
function scope(event: KeyboardEvent): boolean {
  const target = event.target;
  return shortcutAllowed({
    composing: composing || event.isComposing || event.keyCode === 229,
    editable:
      target instanceof Element &&
      !!target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'),
    control: target instanceof Element && !!target.closest('button,a'),
    canvas: target instanceof Element && !!target.closest('#board'),
  });
}
document.addEventListener('keydown', (e) => {
  if (composing || e.isComposing || e.keyCode === 229) return;
  if (e.key === 'F1') {
    e.preventDefault();
    if (!e.repeat) dispatch({ kind: 'rail', view: 'keys' });
    return;
  }
  if (e.key === 'Escape' && state.rail.length) {
    e.preventDefault();
    dispatch({ kind: 'escape' });
    return;
  }
  if (!scope(e)) return;
  if (e.key === 'Escape') {
    dispatch({ kind: 'selection', ids: [] });
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    dispatch({ kind: 'select-all' });
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (!e.repeat) {
      spaceHeld = true;
      spaceMoved = false;
    }
    return;
  }
  keyboard = true;
  if (e.key === 'Enter' && state.focusId) {
    e.preventDefault();
    dispatch({ kind: 'rail', view: 'reader' });
  } else if (e.key === 'ArrowRight' && siblings(objects, state.focusId).length) {
    e.preventDefault();
    child();
  } else if (e.key === 'ArrowLeft' && objects.find((o) => o.id === state.focusId)?.parentId) {
    e.preventDefault();
    parent();
  } else if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) {
    e.preventDefault();
    dispatch({ kind: 'navigate', step: ['ArrowUp', 'ArrowLeft'].includes(e.key) ? -1 : 1 });
  } else if (e.key === '?' && !e.repeat) {
    e.preventDefault();
    dispatch({ kind: 'rail', view: 'keys' });
  } else if (e.key === '/') {
    e.preventDefault();
    dispatch({ kind: 'outline', open: true });
    input('search').focus();
  } else if (state.letters) {
    const key = e.key.toLowerCase();
    if (key === 'j' || key === 'k') {
      e.preventDefault();
      dispatch({ kind: 'navigate', step: key === 'j' ? 1 : -1 });
    } else if (key === 'x' && state.focusId && !e.repeat) {
      e.preventDefault();
      dispatch({ kind: 'toggle', id: state.focusId });
    } else if (key === 'v' || key === 'h') dispatch({ kind: 'tool', tool: key === 'v' ? 'select' : 'pan' });
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    if (spaceHeld && !spaceMoved && scope(e) && state.focusId) dispatch({ kind: 'toggle', id: state.focusId });
    spaceHeld = false;
  }
});
const pointers = new Map<number, Point>();
let lastTapped: string | null = null;
let drag: {
  id: number;
  start: Point;
  previous: Point;
  target: string | null;
  pan: boolean;
  moved: boolean;
  shift: boolean;
} | null = null;
const point = (e: PointerEvent): Point => ({ x: e.clientX, y: e.clientY });
board.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  pointers.set(e.pointerId, point(e));
  board.setPointerCapture(e.pointerId);
  const target =
    e.target instanceof Element ? (e.target.closest<HTMLElement>('[data-object-id]')?.dataset.objectId ?? null) : null;
  drag = {
    id: e.pointerId,
    start: point(e),
    previous: point(e),
    target,
    pan: state.tool === 'pan' || spaceHeld || e.button === 1 || e.pointerType === 'touch',
    moved: false,
    shift: e.shiftKey,
  };
  board.focus({ preventScroll: true });
  e.preventDefault();
});
board.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const before = [...pointers.values()];
  pointers.set(e.pointerId, point(e));
  const after = [...pointers.values()];
  if (before.length === 2 && after.length === 2) {
    dispatch({ kind: 'pinch', before: [before[0], before[1]], after: [after[0], after[1]] });
    if (drag) drag.moved = true;
    spaceMoved = true;
    return;
  }
  if (!drag || drag.id !== e.pointerId) return;
  if (Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y) > 4) drag.moved = true;
  if (drag.pan && drag.moved) {
    dispatch({ kind: 'pan', delta: { x: e.clientX - drag.previous.x, y: e.clientY - drag.previous.y } });
    spaceMoved = true;
    board.classList.add('dragging');
  }
  drag.previous = point(e);
});
board.addEventListener('pointerup', (e) => {
  lastTapped = drag && !drag.moved ? drag.target : null;
  if (drag && !drag.moved && !spaceHeld && state.tool === 'select') {
    if (drag.target) choose(drag.target, drag.shift, false);
    else dispatch({ kind: 'selection', ids: [] });
  }
  pointers.delete(e.pointerId);
  drag = null;
  board.classList.remove('dragging');
});
const cancel = (): void => {
  pointers.clear();
  drag = null;
  spaceHeld = false;
  spaceMoved = false;
  board.classList.remove('dragging');
};
board.addEventListener('pointercancel', cancel);
board.addEventListener('lostpointercapture', cancel);
window.addEventListener('blur', cancel);
board.addEventListener('dblclick', (e) => {
  const target =
    e.target instanceof Element ? e.target.closest<HTMLElement>('[data-object-id]')?.dataset.objectId : null;
  const id = target ?? lastTapped;
  if (id) {
    dispatch({ kind: 'focus', id });
    dispatch({ kind: 'rail', view: 'reader' });
  }
});
board.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    dispatch({ kind: 'zoom', anchor: { x: e.clientX, y: e.clientY }, factor: Math.exp(-e.deltaY * 0.0015) });
  },
  { passive: false }
);
const sync = new CanvasSync(
  url,
  workspaceId,
  (snapshot) => {
    objects = snapshot.objects;
    renderer.objects(objects);
    renderer.filter(input('search').value);
    if (initial) {
      initial = false;
      const firstReadable = mobile.matches
        ? outline(objects).find(({ object }) => !container(object))?.object
        : undefined;
      fit(firstReadable ? [firstReadable.id] : undefined);
    }
    node('state').hidden = !!objects.length;
    if (!objects.length) {
      node('state').querySelector('h1')!.textContent = 'A place for your work';
      node('state').querySelector('p')!.textContent =
        'This canvas holds the ideas and references for your project. Objects added by your agents will appear here.';
    }
    dispatch({ kind: 'viewport', viewport: state.viewport });
  },
  (status) => {
    node('notice').hidden = status !== 'offline';
    node('notice').textContent = 'Connection lost. Your canvas is still here; reconnecting…';
    if (status === 'error' || status === 'loading') {
      node('state').hidden = false;
      node('state').querySelector('h1')!.textContent =
        status === 'error' ? 'Canvas could not load' : 'Opening your canvas';
      node('state').querySelector('p')!.textContent =
        status === 'error' ? 'Check your connection, then try again.' : 'Loading the workspace…';
    }
    button('retry').hidden = status !== 'error';
  }
);
button('retry').onclick = () => void sync.start();
void sync.start();
void fetch(url('/api/canvas/workspaces'))
  .then((r) => r.json())
  .then((data: unknown) => {
    if (typeof data !== 'object' || data === null || !('data' in data)) return;
    // Workspace names are optional presentation data; object loading remains independent.
    const parsed = workspaceNames.safeParse(data);
    const name = parsed.success ? parsed.data.data.workspaces.find((w) => w.id === workspaceId)?.caseName : undefined;
    if (name) {
      node('workspaceName').textContent = name;
      document.title = `${name} · Canvas`;
    }
  })
  .catch(() => {});
import { z } from 'zod';
const workspaceNames = z.object({
  data: z.object({ workspaces: z.array(z.object({ id: z.string(), caseName: z.string() })) }),
});
window.addEventListener('pagehide', () => sync.stop(), { once: true });
board.focus({ preventScroll: true });
dispatch({ kind: 'viewport', viewport: state.viewport });
