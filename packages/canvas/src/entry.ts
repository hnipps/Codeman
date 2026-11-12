import { wheelFactor } from './viewport.js';
import { DesktopEditor } from './edit.js';
import { joinBasePath } from '../../../src/config/base-path.js';
import { command, initialView, subcanvasIndex, viewPath, type ViewCommand, type ViewState } from './commands.js';
import { container, label, readable, type ViewObject } from './model.js';
import { Renderer } from './render.js';
import { CanvasSync } from './sync.js';
import { shortcutAllowed, shortcuts, editShortcuts } from './shortcuts.js';
import { outline, siblings, worldBounds } from './tree.js';
import { hit, union, type Point, type Rect } from './viewport.js';
import { phoneFirstView, phoneMode, trackKeyboard, visibleRect, revealDelta } from './mobile.js';
import { CommentsView, commentCounts } from './comments.js';
import { HistoryView } from './history.js';
import { snapshotComments } from './sync.js';

declare global {
  interface Window {
    canvasEdit: ReturnType<DesktopEditor['adapter']>;
    canvasView: { dispatch: (action: ViewCommand) => void; read: () => ViewState };
    canvasComments: { read: () => CommentsView['all']; post: (objectId: string, text: string) => Promise<boolean> };
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
// A tapped button takes no focus on iOS, so the control a tap pressed stands in as the opener.
let pressed: HTMLElement | null = null;
document.addEventListener(
  'click',
  (e) => {
    pressed = e.target instanceof Element ? e.target.closest<HTMLElement>('button') : null;
  },
  true
);
function opener(): HTMLElement {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) return active;
  return pressed?.isConnected ? pressed : board;
}
let initial = true,
  pendingFocus: HTMLElement | null = null,
  railDepth = 0;
const mobile = phoneMode();
trackKeyboard();
state = command(state, { kind: 'outline', open: !mobile.matches }, objects);
const assetUrl = (assetId: string): string | null =>
  /^[a-f0-9]{64}$/.test(assetId) ? url(`/api/canvas/${workspaceId}/assets/${assetId}`) : null;
const renderer = new Renderer(layer, tree, choose, { assetUrl });
/** Objects drawn in the current view: the open sub-canvas's contents, or the workspace level. */
function inView(all: ViewObject[] = objects): ViewObject[] {
  const enclosing = subcanvasIndex(all);
  return all.filter((o) => o.id !== state.root && enclosing.get(o.id) === state.root);
}
let paintedRoot: string | null | undefined;
/** Inside a sub-canvas, keyboard walks and select-all start from its contents, not the workspace. */
function scopedAction(action: ViewCommand): ViewCommand {
  if (state.root === null || state.focusId) return action;
  const first = siblings(objects, state.root)[0];
  if (action.kind === 'navigate' && first) return { kind: 'focus', id: first.id };
  if (action.kind === 'select-all') return { kind: 'selection', ids: siblings(objects, state.root).map((o) => o.id) };
  return action;
}
/** Selection and focus never land on an object the current view does not draw. */
function viewScoped(before: ViewState, next: ViewState): ViewState {
  if (next.root !== before.root) return next;
  const members = new Set(inView().map((o) => o.id));
  const selected = next.selected.filter((id) => members.has(id));
  const focusId = next.focusId && !members.has(next.focusId) ? before.focusId : next.focusId;
  return selected.length === next.selected.length && focusId === next.focusId ? next : { ...next, selected, focusId };
}
const comments = new CommentsView({
  url,
  workspace: workspaceId,
  objects: () => objects,
  choose: (id) => {
    dispatch({ kind: 'focus', id });
    dispatch({ kind: 'selection', ids: [id] });
    reveal(id);
  },
});
const history = new HistoryView({ url, workspace: workspaceId, phone: mobile, objects: () => objects });
const icons: Record<string, string> = {
  undoEdit: 'M7 4L3 8l4 4M3 8h8a5 5 0 0 1 5 5v3',
  redoEdit: 'M13 4l4 4-4 4M17 8H9a5 5 0 0 0-5 5v3',
  selectTool: 'M5 3l12 8-6 1-3 6z',
  panTool:
    'M7 10V5a1 1 0 0 1 2 0v4-1-5a1 1 0 0 1 2 0v5-1-3a1 1 0 0 1 2 0v4-1-2a1 1 0 0 1 2 0v6c0 4-2 6-5 6-2 0-3-1-4-3l-3-5a1 1 0 0 1 2-1z',
  addTool: 'M10 3v14M3 10h14',
  chatTool: 'M3 3h14v11H8l-5 4zM6 7h8M6 10h5',
  keys: 'M6 6a4 4 0 1 1 6 4c-2 1-2 2-2 3M10 17h.01',
  closeOutline: 'M13 4l-6 6 6 6',
  openOutline: 'M3 4h14v12H3zM7 4v12',
  closeRail: 'M5 5l10 10M15 5L5 15',
  closeSheet: 'M5 5l10 10M15 5L5 15',
  sectionsTool: 'M4 5h12M7 10h9M7 15h9M4 10h.01M4 15h.01',
  findTool: 'M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM13.5 13.5L17 17',
  alignXStart: 'M3 3v14M6 5h9v3H6zM6 12h6v3H6z',
  alignXCenter: 'M10 3v14M5 5h10v3H5zM7 12h6v3H7z',
  alignXEnd: 'M17 3v14M5 5h9v3H5zM8 12h6v3H8z',
  alignYStart: 'M3 3h14M5 6h3v9H5zM12 6h3v6h-3z',
  alignYCenter: 'M3 10h14M5 5h3v10H5zM12 7h3v6h-3z',
  alignYEnd: 'M3 17h14M5 5h3v9H5zM12 8h3v6h-3z',
  distributeX: 'M3 4v12M17 4v12M8 6h4v8H8z',
  distributeY: 'M4 3h12M4 17h12M6 8h8v4H6z',
};
for (const [id, path] of Object.entries(icons)) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(svg.namespaceURI, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  node(id).prepend(svg);
}
node('outline').tabIndex = -1;
const safeProbe = document.createElement('div');
safeProbe.id = 'safeProbe';
safeProbe.setAttribute('aria-hidden', 'true');
document.body.append(safeProbe);
function insets() {
  const style = getComputedStyle(safeProbe);
  return {
    top: parseFloat(style.paddingTop) || 0,
    right: parseFloat(style.paddingRight) || 0,
    bottom: parseFloat(style.paddingBottom) || 0,
    left: parseFloat(style.paddingLeft) || 0,
  };
}
const rectOf = (id: string): Rect | null => {
  const el = document.getElementById(id);
  if (!el || el.hidden) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};
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
function area(): Rect {
  if (mobile.matches) {
    paintSheet();
    return visibleRect({ width: innerWidth, height: innerHeight }, insets(), [
      rectOf('dock'),
      rectOf('fit'),
      rectOf('sheet'),
    ]);
  }
  return {
    x: state.outlineOpen && !mobile.matches ? 192 : 0,
    y: 0,
    width: innerWidth - (state.outlineOpen && !mobile.matches ? 192 : 0),
    height: innerHeight,
  };
}
function fit(ids?: string[]): void {
  const targets = (ids ? objects : inView()).filter((o) => o.deletedAt === null && (!ids || ids.includes(o.id)));
  dispatch({ kind: 'fit', bounds: union(targets.map((o) => worldBounds(objects, o))), area: area() });
}
function firstPhoneView(): void {
  const live = objects.filter((o) => o.deletedAt === null);
  const top = outline(live).filter((e) => e.depth === 0);
  const first = (top.find((e) => container(e.object)) ?? top[0])?.object;
  const viewport = phoneFirstView(
    union(live.map((o) => worldBounds(objects, o))),
    first ? worldBounds(objects, first) : null,
    area()
  );
  dispatch({ kind: 'viewport', viewport });
}
function reveal(id: string): void {
  const o = objects.find((o) => o.id === id);
  if (!o) return;
  const r = worldBounds(objects, o),
    v = state.viewport,
    a = area();
  if (mobile.matches) {
    const delta = revealDelta(
      { x: r.x * v.zoom + v.x, y: r.y * v.zoom + v.y, width: r.width * v.zoom, height: r.height * v.zoom },
      a
    );
    if (delta.x || delta.y) dispatch({ kind: 'pan', delta });
    return;
  }
  const x = (r.x + r.width / 2) * v.zoom + v.x,
    y = (r.y + r.height / 2) * v.zoom + v.y;
  if (!hit({ x: a.x + 32, y: 48, width: Math.max(1, a.width - 64), height: a.height - 144 }, { x, y }))
    dispatch({ kind: 'pan', delta: { x: a.x + a.width / 2 - x, y: a.height / 2 - y } });
}
function choose(id: string, toggle: boolean, bring: boolean): void {
  const read = bring && mobile.matches && state.focusId === id && state.selected.includes(id);
  keyboard = false;
  dispatch({ kind: 'focus', id });
  dispatch(toggle ? { kind: 'toggle', id } : { kind: 'selection', ids: [id] });
  if (bring) {
    if (mobile.matches) dispatch({ kind: 'outline', open: false });
    reveal(id);
  }
  board.focus({ preventScroll: true });
  if (read) dispatch({ kind: 'rail', view: 'reader' });
}
function dispatch(action: ViewCommand): void {
  if (action.kind === 'rail' && state.rail.at(-1) !== action.view) railOrigins.set(action.view, opener());
  const closing = state.rail.at(-1);
  const previous = state.rail.length;
  const root = state.root;
  state = viewScoped(state, command(state, scopedAction(action), objects));
  if (state.root !== root) {
    renderer.root(state.root);
    paintedRoot = state.root;
    paintViewPath();
    keyboard = true;
    const members = inView().map((o) => o.id);
    if (members.length) fit(members);
    else if (state.root) fit([state.root]);
    else fit();
    if (action.kind === 'leave' && state.focusId)
      requestAnimationFrame(() => renderer.elements.get(state.focusId ?? '')?.focus({ preventScroll: true }));
    node('announcement').textContent = state.root
      ? `Opened ${label(objects.find((o) => o.id === state.root) ?? objects[0])}`
      : 'Back to the workspace';
  }
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
    // A touch keyboard would cover half the outline; search takes focus only when tapped or asked for.
    (action.open ? (mobile.touch ? node('outline') : input('search')) : board).focus({ preventScroll: true });
  }
  if (!frame) frame = requestAnimationFrame(paint);
}
window.canvasView = { dispatch, read: () => structuredClone(state) };
/**
 * The line under the outline header while a sub-canvas is open: a back control named for
 * where it goes, then the open sub-canvas. When nested deeper the immediate parent sits
 * between them and truncates first. The workspace name stays in the header above.
 */
function paintViewPath(): void {
  const crumbs = node('viewPath');
  crumbs.replaceChildren();
  crumbs.hidden = state.root === null;
  if (state.root === null) return;
  const path = viewPath(objects, state.root);
  const current = path.at(-1);
  const parent = path.at(-2);
  const parentName = parent ? label(parent) : node('workspaceName').textContent || 'Canvas';
  const back = document.createElement('button');
  back.className = 'crumb-back';
  back.setAttribute('aria-label', `Back to ${parentName}`);
  back.title = `Back to ${parentName} · Esc`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const arrow = document.createElementNS(svg.namespaceURI, 'path');
  arrow.setAttribute('d', 'M16 10H4M9 5l-5 5 5 5');
  svg.append(arrow);
  back.append(svg);
  back.addEventListener('click', () => {
    dispatch({ kind: 'leave' });
    board.focus({ preventScroll: true });
  });
  crumbs.append(back);
  if (parent) {
    const middle = document.createElement('span');
    middle.className = 'crumb crumb-parent';
    middle.textContent = parentName;
    middle.title = parentName;
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = '/';
    crumbs.append(middle, sep);
  }
  const here = document.createElement('span');
  here.className = 'crumb crumb-current';
  here.setAttribute('aria-current', 'location');
  here.textContent = current ? label(current) : '';
  here.title = here.textContent;
  crumbs.append(here);
}
function paint(): void {
  frame = 0;
  if (paintedRoot !== state.root) {
    renderer.root(state.root);
    paintedRoot = state.root;
    paintViewPath();
  }
  renderer.view(state, keyboard);
  editor.media.frames();
  node('outline').hidden = !state.outlineOpen;
  node('openOutline').hidden = state.outlineOpen;
  node('rail').hidden = !state.rail.length;
  node('keysView').hidden = state.rail.at(-1) !== 'keys';
  node('readerView').hidden = state.rail.at(-1) !== 'reader';
  node('threadView').hidden = state.rail.at(-1) !== 'thread';
  node('historyView').hidden = state.rail.at(-1) !== 'history';
  const focused = objects.find((o) => o.id === state.focusId);
  const top = state.rail.at(-1);
  if (top === 'thread') comments.show(focused?.id ?? null);
  else comments.hide();
  if (top === 'history') {
    if (railView !== 'history') history.show();
  } else history.hide();
  railView = top;
  const commentCount = focused ? (commentCounts(comments.all).get(focused.id) ?? 0) : 0;
  button('readerComments').textContent = commentCount ? `Comments · ${commentCount}` : 'Comments';
  node('railTitle').textContent =
    top === 'thread'
      ? comments.title(focused?.id ?? null)
      : top === 'history'
        ? 'History'
        : state.rail.at(-1) === 'reader'
          ? focused
            ? container(focused)
              ? label(focused)
              : focused.type.charAt(0).toUpperCase() + focused.type.slice(1)
            : 'Object no longer available'
          : 'Keys';
  document.documentElement.style.setProperty('--outline-space', state.outlineOpen && !mobile.matches ? '192px' : '0px');
  button('selectTool').setAttribute('aria-pressed', String(state.tool === 'select'));
  button('panTool').setAttribute('aria-pressed', String(state.tool === 'pan'));
  board.classList.toggle('panning', state.tool === 'pan' || spaceHeld);
  button('letters').setAttribute('aria-checked', String(state.letters));
  if (
    state.rail.at(-1) === 'reader' &&
    (readerObject !== objects.find((o) => o.id === state.focusId) || readerFocus !== state.focusId)
  )
    readObject();
  if (state.rail.length > railDepth && state.rail.at(-1) === 'keys') input('keysSearch').focus();
  paintSheet();
  if (pendingFocus) {
    pendingFocus.focus({ preventScroll: true });
    pendingFocus = null;
  }
  railDepth = state.rail.length;
  editor.paint();
}
let railView: string | undefined;
function paintSheet(): void {
  const o = objects.find((o) => o.id === state.focusId);
  const show =
    mobile.matches &&
    !!o &&
    state.selected.length === 1 &&
    state.selected[0] === o.id &&
    !state.rail.length &&
    !state.outlineOpen;
  const sheet = node('sheet');
  if (sheet.hidden === !show && (!show || sheet.dataset.sheetFor === o?.id)) {
    if (show && o) paintSheetCount(o.id);
    return;
  }
  sheet.hidden = !show;
  if (!show || !o) {
    delete sheet.dataset.sheetFor;
    return;
  }
  sheet.dataset.sheetFor = o.id;
  node('sheetTitle').textContent = label(o);
  const count = siblings(objects, o.id).length;
  const excerpt = readable(o).replace(/\s+/g, ' ').trim();
  node('sheetMeta').textContent = container(o)
    ? `${o.type.charAt(0).toUpperCase() + o.type.slice(1)} · ${count ? `${count} ${count === 1 ? 'item' : 'items'}` : 'Empty'}`
    : excerpt === label(o)
      ? ''
      : excerpt.slice(0, 120);
  node('sheetMeta').hidden = !node('sheetMeta').textContent;
  button('sheetParent').hidden = !o.parentId;
  paintSheetCount(o.id);
}
function paintSheetCount(id: string): void {
  const n = commentCounts(comments.all).get(id) ?? 0;
  button('sheetComments').textContent = n ? `Comments · ${n}` : 'Comments';
}
let readerObject: ViewObject | undefined,
  readerFocus: string | null = null;
function readObject(): void {
  const o = objects.find((o) => o.id === state.focusId);
  readerObject = o;
  readerFocus = state.focusId;
  const body =
    o && container(o) && o.content.type === o.type
      ? ''
      : o
        ? readable(o)
        : 'This object was removed from the workspace.';
  node('readerText').textContent = body;
  node('readerText').hidden = !body;
  const count = o ? siblings(objects, o.id).length : 0;
  node('readerCount').hidden = !o || !container(o);
  node('readerCount').textContent = count ? `${count} ${count === 1 ? 'item' : 'items'}` : 'Empty';
  node('readerMeta').replaceChildren();
  if (o) {
    const dates: [string, number][] = [['Created', o.createdAt]];
    if (o.updatedAt !== o.createdAt) dates.push(['Updated', o.updatedAt]);
    for (const [title, value] of [
      ['Author', o.author.kind === 'human' ? o.author.userId : `Agent · ${o.author.sessionId}`],
      ...dates.map(([title, timestamp]) => [
        title,
        new Date(timestamp).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
      ]),
    ]) {
      const dt = document.createElement('dt'),
        dd = document.createElement('dd');
      dt.textContent = title;
      if (title === 'Created' || title === 'Updated') {
        const time = document.createElement('time');
        time.dateTime = new Date(title === 'Created' ? o.createdAt : o.updatedAt).toISOString();
        time.title = time.dateTime;
        time.textContent = value;
        dd.append(time);
      } else dd.textContent = value;
      node('readerMeta').append(dt, dd);
    }
  }
  button('parent').hidden = !o?.parentId;
  button('children').hidden = !o || !siblings(objects, o.id).length;
}
const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
const keyNames: Record<string, string> = {
  '←': 'Left arrow',
  '→': 'Right arrow',
  '↑': 'Up arrow',
  '↓': 'Down arrow',
  '⌘': 'Command',
};
for (const [action, alternatives] of [...shortcuts, ...(mobile.matches ? [] : editShortcuts)]) {
  const row = document.createElement('div'),
    title = document.createElement('span'),
    hints = document.createElement('span');
  row.className = 'key-row';
  title.textContent = action;
  hints.className = 'key-hints';
  for (const [index, chord] of alternatives.entries()) {
    if (index) hints.append(document.createTextNode('\u2009/\u2009'));
    const group = document.createElement('span');
    group.className = 'key-chord';
    for (const key of chord) {
      const cap = document.createElement('kbd');
      cap.textContent = key === 'Mod' ? modifier : key;
      const name = keyNames[cap.textContent];
      if (name) {
        cap.setAttribute('role', 'img');
        cap.setAttribute('aria-label', name);
      }
      group.append(cap);
    }
    hints.append(group);
  }
  row.append(title, hints);
  node('keyRows').append(row);
}
for (const hint of document.querySelectorAll<HTMLElement>('.action-menu [data-keys]')) {
  hint.setAttribute('aria-hidden', 'true');
  for (const key of hint.dataset.keys?.split(' ') ?? []) {
    const cap = document.createElement('kbd');
    cap.textContent = key === 'Mod' ? modifier : key;
    hint.append(cap);
  }
}
input('keysSearch').oninput = () => {
  for (const row of node('keyRows').children)
    if (row instanceof HTMLElement)
      row.hidden = !row.textContent?.toLowerCase().includes(input('keysSearch').value.toLowerCase());
};
input('search').oninput = () => renderer.filter(input('search').value);
button('clearSearch').onclick = () => {
  input('search').value = '';
  renderer.filter('');
  input('search').focus();
};
button('openOutline').onclick = () => dispatch({ kind: 'outline', open: true });
button('closeOutline').onclick = () => {
  dispatch({ kind: 'outline', open: false });
  board.focus();
};
button('closeRail').onclick = () => dispatch({ kind: 'escape' });
button('outlineHistory').onclick = () => dispatch({ kind: 'rail', view: 'history' });
button('sectionsTool').onclick = () => dispatch({ kind: 'outline', open: true });
button('findTool').onclick = () => {
  dispatch({ kind: 'outline', open: true });
  input('search').focus();
};
function openThread(): void {
  const id = state.focusId ?? state.selected[0] ?? null;
  if (id && id !== state.focusId) dispatch({ kind: 'focus', id });
  dispatch({ kind: 'rail', view: 'thread' });
  if (id && !mobile.touch) requestAnimationFrame(() => comments.focusComposer());
}
button('chatTool').onclick = openThread;
button('readerComments').onclick = openThread;
button('sheetComments').onclick = openThread;
button('sheetRead').onclick = () => dispatch({ kind: 'rail', view: 'reader' });
button('sheetParent').onclick = () => {
  const o = objects.find((o) => o.id === state.focusId);
  if (o?.parentId) {
    choose(o.parentId, false, true);
    button('sheetRead').focus({ preventScroll: true });
  }
};
button('closeSheet').onclick = () => {
  dispatch({ kind: 'selection', ids: [] });
  board.focus({ preventScroll: true });
};
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
  // Escape from a page in use hands the keyboard back to the canvas before anything else.
  if (e.key === 'Escape' && editor.media.escape()) {
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape' && state.rail.length) {
    e.preventDefault();
    dispatch({ kind: 'escape' });
    return;
  }
  if (!scope(e)) return;
  if (e.key === 'Escape') {
    // Escape clears the selection first; with nothing selected it leaves an open sub-canvas.
    if (!state.selected.length && state.root !== null) dispatch({ kind: 'leave' });
    else dispatch({ kind: 'selection', ids: [] });
    return;
  }
  if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const target = objects.find((o) => o.id === (state.selected.length === 1 ? state.selected[0] : state.focusId));
    if (e.key === 'ArrowUp') dispatch({ kind: 'leave' });
    else if (target?.type === 'subcanvas') dispatch({ kind: 'enter', id: target.id });
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
let lastTap: { id: string; at: number; point: Point } | null = null;
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
  if (spaceHeld) spaceMoved = true;
  pointers.set(e.pointerId, point(e));
  board.setPointerCapture(e.pointerId);
  const target =
    e.target instanceof Element ? (e.target.closest<HTMLElement>('[data-object-id]')?.dataset.objectId ?? null) : null;
  drag = {
    id: e.pointerId,
    start: point(e),
    previous: point(e),
    target,
    // A phone never moves objects: every one-finger drag pans, and only a tap selects.
    pan: state.tool === 'pan' || spaceHeld || e.button === 1 || e.pointerType === 'touch' || mobile.matches,
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
  if (Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y) > (e.pointerType === 'touch' ? 8 : 4))
    drag.moved = true;
  if (drag.pan && drag.moved) {
    dispatch({ kind: 'pan', delta: { x: e.clientX - drag.previous.x, y: e.clientY - drag.previous.y } });
    spaceMoved = true;
    board.classList.add('dragging');
  }
  drag.previous = point(e);
});
board.addEventListener('pointerup', (e) => {
  const tap = drag && !drag.moved && !drag.pan ? drag.target : null;
  const doubleTap =
    tap &&
    lastTap &&
    lastTap.id === tap &&
    e.timeStamp - lastTap.at < 500 &&
    Math.hypot(e.clientX - lastTap.point.x, e.clientY - lastTap.point.y) < 6;
  lastTap = tap && !doubleTap ? { id: tap, at: e.timeStamp, point: point(e) } : null;
  if (drag && !drag.moved && !spaceHeld && state.tool === 'select') {
    if (drag.target) choose(drag.target, drag.shift, false);
    else dispatch({ kind: 'selection', ids: [] });
  }
  if (doubleTap && tap) {
    const tapped = objects.find((o) => o.id === tap);
    if (tapped?.type === 'subcanvas' && tapped.content.type === 'subcanvas') dispatch({ kind: 'enter', id: tap });
    else if (tapped?.type === 'link' && tapped.content.type === 'link' && !mobile.matches)
      editor.media.openLink(tapped);
    else {
      dispatch({ kind: 'focus', id: tap });
      dispatch({ kind: 'rail', view: 'reader' });
    }
  }
  pointers.delete(e.pointerId);
  drag = null;
  board.classList.remove('dragging');
});
const cancel = (): void => {
  pointers.clear();
  drag = null;
  lastTap = null;
  board.classList.remove('dragging');
};
board.addEventListener('pointercancel', cancel);
board.addEventListener('lostpointercapture', (e) => {
  if (pointers.has(e.pointerId)) cancel();
});
window.addEventListener('blur', () => {
  cancel();
  spaceHeld = false;
  spaceMoved = false;
});
board.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    dispatch({
      kind: 'zoom',
      anchor: { x: e.clientX, y: e.clientY },
      factor: wheelFactor(e.deltaY, e.deltaMode, innerHeight),
    });
  },
  { passive: false }
);
const editor = new DesktopEditor({
  url,
  workspace: workspaceId,
  viewer: document.querySelector<HTMLMetaElement>('meta[name="codeman-canvas-viewer"]')?.content || '@single',
  mobile,
  view: () => state,
  objects: () => objects,
  dispatch,
  focusMode: (value) => {
    keyboard = value;
    if (!frame) frame = requestAnimationFrame(paint);
  },
  assetUrl,
  display: (displayed) => {
    objects = displayed;
    // A sub-canvas that was deleted while open returns the view to the workspace.
    while (state.root !== null && !objects.some((o) => o.id === state.root)) state = { ...state, root: null };
    const lostFocus =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.matches('[data-object-id]') &&
      !objects.some((o) => o.id === document.activeElement?.getAttribute('data-object-id'));
    renderer.objects(objects);
    renderer.root(state.root);
    paintedRoot = state.root;
    editor.media.forget(new Set(objects.filter((o) => o.type === 'embed').map((o) => o.id)));
    comments.mark(renderer.elements);
    if (lostFocus) board.focus({ preventScroll: true });
    renderer.filter(input('search').value);
    if (initial) {
      initial = false;
      if (mobile.matches) firstPhoneView();
      else fit();
    }
    node('state').hidden = !!objects.length;
    if (!objects.length) {
      node('state').querySelector('h1')!.textContent = 'A place for your work';
      node('state').querySelector('p')!.textContent =
        'A place for the ideas and references for your project. Add an object to get started.';
    }
    dispatch({ kind: 'viewport', viewport: state.viewport });
  },
});
window.canvasEdit = editor.adapter();
window.canvasComments = {
  read: () => structuredClone(comments.all),
  post: async (objectId, text) => {
    dispatch({ kind: 'focus', id: objectId });
    dispatch({ kind: 'rail', view: 'thread' });
    paint();
    (node('commentDraft') as HTMLTextAreaElement).value = text;
    node('commentDraft').dispatchEvent(new Event('input'));
    return comments.post();
  },
};
const sync = new CanvasSync(
  url,
  workspaceId,
  (snapshot) => {
    comments.update(snapshotComments(snapshot));
    editor.receive(snapshot);
    comments.mark(renderer.elements);
    history.changed();
    if (!frame) frame = requestAnimationFrame(paint);
  },
  (status) => {
    editor.online(status === 'ready');
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
